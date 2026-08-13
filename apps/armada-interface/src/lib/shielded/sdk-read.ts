// ABOUTME: The persistent @armada/sdk instance — IndexedDB-backed, syncs the unlocked wallet and reports
// ABOUTME: its 0zk address / balances / history (reads), and is write-capable (real prover + artifacts) for proving.

import {
  createArmadaSdk,
  IndexedDBStorageAdapter,
  LocalSigner,
  getTokenDataERC20,
  getTokenDataHash,
  type ArmadaSdk,
  type HistoryEntry,
} from '@armada/sdk'
import { getCachedDeployments, getUsdcAddress, loadYieldDeployment } from '../../config/deployments'
import { getNetworkConfig } from '../../config/network'
import * as keyManager from './keyManager'
import { createInterfaceArtifactSource, createInterfaceProver } from './sdk-prover'
import { emitBalanceChange, emitScanStatus } from './balance-bus'
import { sdkTelemetrySink } from './sdk-telemetry'
import { track } from '../telemetry'

/** The shielded yield-vault share token (ayUSDC), if a yield deployment exists. */
async function vaultTokenAddress(): Promise<`0x${string}` | undefined> {
  const yieldDeployment = await loadYieldDeployment()
  return yieldDeployment?.contracts.armadaYieldVault as `0x${string}` | undefined
}

/** The yield adapter (lend/redeemAndShield target), if a yield deployment exists. Threaded into the
 *  SDK's `pool.wrappers.yieldAdapter` so it natively classifies yield ops (history `yield-*`
 *  categories) and binds the correct `crossContract` fee tier. */
async function yieldAdapterAddress(): Promise<`0x${string}` | undefined> {
  const yieldDeployment = await loadYieldDeployment()
  return yieldDeployment?.contracts.armadaYieldAdapter as `0x${string}` | undefined
}

/** Assemble the SDK config from the same deployment + network config the app uses. */
async function readPathConfig(): Promise<{
  pool: {
    chainId: number
    poolAddress: `0x${string}`
    deployBlock: number
    usdcAddress: `0x${string}`
    additionalTokens?: `0x${string}`[]
    wrappers?: { yieldAdapter?: `0x${string}` }
    confirmationDepth: number
    finalityThreshold: number
  }
  rpc: { urls: string[] }
  indexer?: { url: string }
}> {
  const deployments = getCachedDeployments()
  if (deployments === null) throw new Error('sdk-read: deployments not loaded')
  const hub = getNetworkConfig().hub
  const poolAddress = deployments.hub.contracts.privacyPool as `0x${string}` | undefined
  const usdcAddress = getUsdcAddress(deployments, hub) as `0x${string}` | undefined
  if (!poolAddress || !usdcAddress) {
    throw new Error('sdk-read: hub deployment missing privacyPool or usdc')
  }
  // Scan the yield-vault share token too, so the SDK can report shielded ayUSDC shares.
  const vault = await vaultTokenAddress()
  // Yield adapter → `pool.wrappers.yieldAdapter`: lets the SDK natively classify yield ops (history
  // `yield-deposit`/`yield-withdraw` categories) and bind the correct `crossContract` fee tier.
  const yieldAdapter = await yieldAdapterAddress()
  // Quick-sync fast path: when a watcher URL is configured, the SDK uses the native `/v2/quick-sync`
  // indexer as the primary event source (RPC covers the tail + verifies against the on-chain root).
  // Unset → RPC-only slow scan. Parity with the engine's former quickSync path.
  const indexerUrl = getNetworkConfig().indexerUrl
  return {
    pool: {
      chainId: hub.chainId,
      poolAddress,
      deployBlock: deployments.hub.deployBlock ?? 0,
      usdcAddress,
      ...(vault ? { additionalTokens: [vault] } : {}),
      ...(yieldAdapter ? { wrappers: { yieldAdapter } } : {}),
      confirmationDepth: getNetworkConfig().confirmationDepth,
      finalityThreshold: getNetworkConfig().finalityThreshold,
    },
    rpc: { urls: [...hub.rpcUrls] },
    ...(indexerUrl ? { indexer: { url: indexerUrl } } : {}),
  }
}

type ReadWallet = Awaited<ReturnType<ArmadaSdk['wallet']['fromRootSecret']>>

type SdkInstance = { sdk: ArmadaSdk; wallet: ReadWallet; address: string }

// A PERSISTENT SDK instance for the session — IndexedDB-backed, so the scan state survives across reads
// and page reloads (the first sync scans from deployBlock; later ones are
// incremental). Recreated when the unlocked wallet changes; closed on lock via `closeSdkRead`.
let instance: SdkInstance | null = null

// In-flight creation guard. `ensureInstance` is called near-simultaneously on unlock by several flows
// (initial scan, the sync poll's mount fetch, the three balance reads, history recovery). Without
// coalescing, each races past the null check and builds its OWN SDK instance + wallet against the SAME
// IndexedDB scan-state DB — multiple wallets then scan and write one encrypted DB concurrently and
// clobber each other, so early reads see 0 owned notes until the survivors settle. This holds the single
// in-flight build so all concurrent callers for the same identity await one instance.
let pendingInstance: { address: string; promise: Promise<SdkInstance> } | null = null

// IndexedDB database name for the SDK read instance's scan state, partitioned by the (hub chain id,
// PrivacyPool address) pair that uniquely identifies a scan context. Chain id alone is insufficient:
// two deployments on the same chain (different pool address — e.g. switching deployment instances)
// must not share scan state, and the SDK's scan-state key is chain-agnostic (the 0zk address is the
// same across chains), so a shared DB would let their checkpoints clobber each other. The `-e2` marks
// the schema where the SDK owns at-rest encryption (§4.3): it auto-wraps this raw adapter in an
// `EncryptedStore` keyed per-wallet from the viewing key. Distinct from prior schemas (see
// `legacyDbNames`), whose records the SDK can't decrypt under the new key — so we retire them.
function dbNameFor(cfg: Awaited<ReturnType<typeof readPathConfig>>): string {
  return `armada-shielded-scan-e2-${cfg.pool.chainId}-${cfg.pool.poolAddress.toLowerCase()}`
}

// Prior read-DB names for this (chain, pool): the pre-encryption plaintext DB (no suffix) and the
// interface-side `-e1` encryption (rootSecret-derived key, now superseded by the SDK's viewing-key
// encryption). Both are unreadable under the current key, so they are best-effort deleted so no stale
// (plaintext or wrong-key) note data lingers at rest.
function legacyDbNames(cfg: Awaited<ReturnType<typeof readPathConfig>>): string[] {
  const suffix = `${cfg.pool.chainId}-${cfg.pool.poolAddress.toLowerCase()}`
  return [`armada-shielded-scan-${suffix}`, `armada-shielded-scan-e1-${suffix}`]
}

/** Best-effort IndexedDB delete — never throws (a delete error must not block reset / migration). */
function deleteDatabaseByName(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function ensureInstance(): Promise<SdkInstance> {
  const engineAddress = keyManager.getShieldedAddress()
  // Fast path: a ready instance for this identity.
  if (instance !== null && instance.address === engineAddress) return instance
  // Coalesce concurrent creations for the same identity onto one in-flight build (see `pendingInstance`).
  if (pendingInstance !== null && pendingInstance.address === engineAddress) return pendingInstance.promise
  const promise = createInstance(engineAddress)
  pendingInstance = { address: engineAddress, promise }
  try {
    return await promise
  } finally {
    // Clear the marker only if still ours — a later identity change may have replaced it mid-build.
    if (pendingInstance !== null && pendingInstance.promise === promise) pendingInstance = null
  }
}

async function createInstance(engineAddress: string): Promise<SdkInstance> {
  if (instance !== null) await instance.sdk.close()

  const cfg = await readPathConfig()
  // Retire prior read DBs for this (chain, pool) so no stale plaintext / wrong-key note data lingers
  // at rest. Fire-and-forget; the fresh `-e2` DB re-scans from deploy. (§4.3.)
  for (const name of legacyDbNames(cfg)) void deleteDatabaseByName(name)
  const sdk = await createArmadaSdk({
    ...cfg,
    // Raw adapter — the SDK owns at-rest encryption (§4.3): it auto-wraps this in an `EncryptedStore`
    // keyed per-wallet from the viewing key, so decrypted note data is AES-256-GCM-encrypted at rest
    // without us wrapping it (wrapping here would double-encrypt under a mismatched key). Locking tears
    // the instance down (`closeSdkRead`) → the SDK's key is dropped; the DB then holds only ciphertext.
    storage: new IndexedDBStorageAdapter(dbNameFor(cfg)),
    prover: createInterfaceProver(),
    artifacts: createInterfaceArtifactSource(),
    // Quick-sync observability: the SDK emits its `sync.quicksync` outcome (served / tail-covered /
    // root-mismatch-fallback) through this sink, which the interface surfaces as `sdk.quicksync`.
    telemetry: sdkTelemetrySink,
  })
  // Attach a spend signer so the instance is write-capable (planTransfer/prove) — not just view-only.
  // Derived from the same in-memory rootSecret the viewing key comes from, so it adds no new secret
  // exposure; it only signs during prove(). Reads never invoke it.
  const wallet = await sdk.wallet.fromRootSecret(keyManager.getRootSecret(), {
    creationBlock: keyManager.getCreationBlock() ?? 0,
    signer: await LocalSigner.fromRootSecret(keyManager.getRootSecret()),
  })
  // Forward the wallet's scan/balance/note events onto the app buses — the SDK-native replacement for
  // the stock engine's global balance callback + merkletree-scan callback. Scan lifecycle drives the
  // sync banner/gate (scan-status bus); scan-complete/balance/note ping the balance bus (re-read
  // trigger). The wallet (and its listeners) is discarded on `closeSdkRead`, so no teardown is needed.
  wallet.on('scan:started', () => emitScanStatus({ status: 'syncing', progress: 0 }))
  wallet.on('scan:progress', (e) => emitScanStatus({ status: 'syncing', progress: e.fraction }))
  wallet.on('scan:complete', () => {
    emitScanStatus({ status: 'complete', progress: 1 })
    emitBalanceChange({ reason: 'scan' })
  })
  wallet.on('scan:error', () => emitScanStatus({ status: 'failed', progress: 0 }))
  wallet.on('balance:updated', () => emitBalanceChange({ reason: 'balance' }))
  wallet.on('note:received', () => emitBalanceChange({ reason: 'note' }))
  instance = { sdk, wallet, address: engineAddress }
  return instance
}

/**
 * The persistent, write-capable SDK wallet for the unlocked identity (ensures the instance). Used by
 * the write-path builders (`planTransfer` / `prove`). Reads use the sync helpers below.
 */
export async function getSdkWallet(): Promise<ReadWallet> {
  return (await ensureInstance()).wallet
}

// The SDK's `wallet.sync()` has no in-flight guard; two concurrent calls would double-apply the same
// events and corrupt the scan state. Chain every sync so they run strictly one-at-a-time, and each
// caller's sync runs AFTER any in-flight one — so a post-tx refresh still observes the new block
// rather than piggybacking on a scan that started earlier.
let syncChain: Promise<void> = Promise.resolve()

/**
 * Sync the wallet (serialized) and emit a telemetry line so resume-vs-rescan is observable in the
 * console. A low `fromBlock` (≈ deploy block) means a cold rescan; a high one means it resumed from
 * the IndexedDB checkpoint. `scanned: false` = the head hadn't advanced, so no getLogs work was done.
 */
export async function syncTracked(wallet: Pick<ReadWallet, 'sync'>): Promise<void> {
  const run = syncChain.then(async () => {
    const { fromBlock, syncedThrough, scanned } = await wallet.sync()
    track('sdk.sync', { fromBlock, syncedThrough, scanned })
  })
  syncChain = run.catch(() => {}) // a failed sync must not wedge the chain for later callers
  return run
}

/**
 * Trigger a wallet scan to chain head — the refresh entry point the app + tx handlers call after a
 * submit or on the periodic poll. Serialized via `syncTracked`; balance/history updates are delivered
 * asynchronously through the balance bus (the wallet's `on(...)` forwarders), not the return value.
 * `walletId` is accepted for call-site compatibility but ignored — the read instance is keyed by the
 * unlocked identity, not a passed id.
 */
export async function refreshShieldedBalances(_walletId?: string): Promise<void> {
  const { wallet } = await ensureInstance()
  await syncTracked(wallet)
}

// Reads below deliberately DO NOT call `syncTracked` — they read the current scan state only. Syncing
// is driven solely by `refreshShieldedBalances` (the 15s poll, post-tx refresh, and the initial unlock
// scan). These reads are invoked from the balance-bus event handlers, which fire BECAUSE a sync just
// completed — re-syncing there would be circular and produce a self-sustaining sync cascade (a sync
// emits `scan:complete` → a balance read that re-syncs → another `scan:complete` → …).

/**
 * Read the current shielded USDC balance from the scan state, split into `spendable` (notes past the
 * `finalityThreshold` confirmation buffer — safe to prove/spend) and `pending` (notes newer than that
 * — visible but not yet spendable). On local Anvil (`finalityThreshold` 0) `pending` is always 0.
 * Does not sync. Callers surface `spendable` for MAX / the fee-on-top guard; `pending` is display-only.
 */
export async function readSdkUsdcBalance(): Promise<{ spendable: bigint; pending: bigint }> {
  const { wallet } = await ensureInstance()
  const cfg = await readPathConfig()
  const usdcHash = getTokenDataHash(getTokenDataERC20(cfg.pool.usdcAddress))
  const usdc = (await wallet.balances()).find(b => b.tokenHash === usdcHash)
  return usdc ? { spendable: usdc.spendable, pending: usdc.pending } : { spendable: 0n, pending: 0n }
}

// TODO(tier3b): split yield shares into spendable/pending like readSdkUsdcBalance, so the withdraw MAX
// doesn't offer shares still inside the finalityThreshold buffer. Low urgency: on local finalityThreshold
// is 0 (no pending shares), and on sepolia the pre-proof preflight gate (assertSpendPreflight) fast-fails
// a redeem of not-yet-spendable shares — so this is a MAX-button nicety, not a correctness hole.
/** Read the current shielded yield-vault shares (ayUSDC) from the scan state. 0 if no vault. Does not sync. */
export async function readSdkYieldShares(): Promise<bigint> {
  const vault = await vaultTokenAddress()
  if (vault === undefined) return 0n
  const { wallet } = await ensureInstance()
  const vaultHash = getTokenDataHash(getTokenDataERC20(vault))
  const shares = (await wallet.balances()).find(b => b.tokenHash === vaultHash)
  return shares ? shares.spendable + shares.pending : 0n
}

/** Reconstruct the SDK wallet's tx history from the current scan state (optionally only entries at/after `sinceBlock`). Does not sync. */
export async function readSdkHistory(sinceBlock?: number): Promise<HistoryEntry[]> {
  const { wallet } = await ensureInstance()
  return wallet.history(sinceBlock !== undefined ? { sinceBlock } : {})
}

/** Close the persistent instance (call on wallet lock). Idempotent. */
export async function closeSdkRead(): Promise<void> {
  // Drop any in-flight build marker so a lock mid-creation can't leave a stale pending promise that a
  // later caller would await into a closed/orphaned instance.
  pendingInstance = null
  if (instance !== null) {
    const closing = instance.sdk
    instance = null
    await closing.close()
  }
}

/**
 * Wipe the SDK read instance's persisted scan state (Settings → Reset wallet). Closes the instance
 * first (releasing the IndexedDB handle), then deletes the whole read database so the next unlock
 * re-scans from the deploy block. Best-effort: a delete error must never block the reset.
 */
export async function deleteSdkReadStorage(): Promise<void> {
  await closeSdkRead()
  let cfg: Awaited<ReturnType<typeof readPathConfig>>
  try {
    cfg = await readPathConfig()
  } catch {
    return // deployments not loaded → nothing was ever opened, so nothing to delete
  }
  // Delete the current DB plus any prior-schema DBs for this (chain, pool) — other deployments are
  // separate scan contexts and keep their own state.
  for (const name of [dbNameFor(cfg), ...legacyDbNames(cfg)]) await deleteDatabaseByName(name)
}
