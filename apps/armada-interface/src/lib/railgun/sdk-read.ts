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

/** Assemble the SDK config from the same deployment + network config the app uses. */
async function readPathConfig(): Promise<{
  pool: {
    chainId: number
    poolAddress: `0x${string}`
    deployBlock: number
    usdcAddress: `0x${string}`
    additionalTokens?: `0x${string}`[]
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
    },
    rpc: { urls: [...hub.rpcUrls] },
    ...(indexerUrl ? { indexer: { url: indexerUrl } } : {}),
  }
}

type ReadWallet = Awaited<ReturnType<ArmadaSdk['wallet']['fromRootSecret']>>

// A PERSISTENT SDK instance for the session — IndexedDB-backed, so the scan state survives across reads
// and page reloads (the first sync scans from deployBlock; later ones are
// incremental). Recreated when the unlocked wallet changes; closed on lock via `closeSdkRead`.
let instance: { sdk: ArmadaSdk; wallet: ReadWallet; address: string } | null = null

// Separate IDB database from the engine's (`armada-shielded`) so the SDK read instance keeps its
// own scan state. The value retains the legacy `-shadow` name so existing users' persisted scan
// state isn't orphaned by the rename (a changed name would force a full re-scan on next unlock).
const READ_DB_NAME = 'armada-sdk-shadow'

async function ensureInstance(): Promise<{ sdk: ArmadaSdk; wallet: ReadWallet; address: string }> {
  const engineAddress = keyManager.getRailgunAddress()
  if (instance !== null && instance.address === engineAddress) return instance

  if (instance !== null) await instance.sdk.close()

  const cfg = await readPathConfig()
  const sdk = await createArmadaSdk({
    ...cfg,
    storage: new IndexedDBStorageAdapter(READ_DB_NAME),
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

/** Sync the persistent SDK wallet and return its shielded USDC balance (spendable + pending). */
export async function syncSdkUsdcBalance(): Promise<bigint> {
  const { wallet } = await ensureInstance()
  await syncTracked(wallet)
  const cfg = await readPathConfig()
  const usdcHash = getTokenDataHash(getTokenDataERC20(cfg.pool.usdcAddress))
  const usdc = (await wallet.balances()).find(b => b.tokenHash === usdcHash)
  return usdc ? usdc.spendable + usdc.pending : 0n
}

/** Sync the persistent SDK wallet and return its shielded yield-vault shares (ayUSDC). 0 if no vault. */
export async function syncSdkYieldShares(): Promise<bigint> {
  const vault = await vaultTokenAddress()
  if (vault === undefined) return 0n
  const { wallet } = await ensureInstance()
  await syncTracked(wallet)
  const vaultHash = getTokenDataHash(getTokenDataERC20(vault))
  const shares = (await wallet.balances()).find(b => b.tokenHash === vaultHash)
  return shares ? shares.spendable + shares.pending : 0n
}

/** Sync + reconstruct the SDK wallet's tx history (optionally only entries at/after `sinceBlock`). */
export async function syncSdkHistory(sinceBlock?: number): Promise<HistoryEntry[]> {
  const { wallet } = await ensureInstance()
  await syncTracked(wallet)
  return wallet.history(sinceBlock !== undefined ? { sinceBlock } : {})
}

/** Close the persistent instance (call on wallet lock). Idempotent. */
export async function closeSdkRead(): Promise<void> {
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
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(READ_DB_NAME)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}
