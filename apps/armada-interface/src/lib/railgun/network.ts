// ABOUTME: Railgun engine network loader — patches the SDK's NETWORK_CONFIG to point at our PrivacyPool deployment, then loads the hub provider.
// ABOUTME: Always uses NetworkName.Hardhat so the SDK's QuickSync doesn't try to pull real Railgun history; we patch chain.id for Sepolia mode.

import { ethers } from 'ethers'
import { getNetworkConfig } from '@/config/network'
import { loadDeployments } from '@/config/deployments'

// Railgun SDK + shared-models imports are deferred — see lib/railgun/wallet.ts for why
// (jsdom + circomlibjs init crash). One dynamic import per session.
async function railgunWalletSdk() {
  return import('@railgun-community/wallet')
}
async function railgunSharedModels() {
  return import('@railgun-community/shared-models')
}

/**
 * Railgun-side network identity for our hub. We always pin to `Hardhat` because the SDK's
 * QuickSync for real networks (Ethereum_Sepolia, Mainnet, etc.) tries to download historical
 * commitments that don't match our POC deployment. Hardhat has no QuickSync, so the SDK only
 * scans events from our own PrivacyPool contract.
 *
 * In Sepolia mode we ALSO patch the Hardhat entry's chain.id to the real Sepolia id (11155111)
 * so `networkForChain({type:0, id:11155111})` resolves to our patched Hardhat entry, AND
 * neutralize the real Ethereum_Sepolia entry so it doesn't shadow ours.
 */
const RAILGUN_NETWORK_KEY = 'Hardhat'

/** One-shot RPC timeout. ethers' default FetchRequest timeout is ~300s, which defeats failover —
 *  a black-holed endpoint would hang for 5 min. Cap at 15s so callers fail (or fall back) fast. */
const ONE_SHOT_RPC_TIMEOUT_MS = 15_000

/**
 * Build a one-shot JsonRpcProvider with an explicit fetch timeout (P1-18). Plain
 * `new JsonRpcProvider(url)` inherits ethers' ~300s default, so a wedged RPC pins the caller far
 * past any reasonable budget. Constructing from a `FetchRequest` lets us bound it.
 */
function timeoutProvider(url: string, timeoutMs: number = ONE_SHOT_RPC_TIMEOUT_MS): ethers.JsonRpcProvider {
  const req = new ethers.FetchRequest(url)
  req.timeout = timeoutMs
  return new ethers.JsonRpcProvider(req)
}

function sdkPollIntervalMs(): number {
  return getNetworkConfig().mode === 'sepolia' ? 15_000 : 2_000
}

/**
 * Sepolia fallback when the deployment manifest doesn't carry a `deployBlock` field (older
 * manifests). Local Anvil = 0 (full history is tiny). This is purely defensive — the manifest
 * value takes precedence whenever it's present.
 *
 * The SDK uses NETWORK_CONFIG.<name>.deploymentBlock to bound the initial historical scan in
 * RailgunEngine.getStartScanningBlock — see node_modules/@railgun-community/engine/dist/
 * railgun-engine.js. A stale or wrong value here means the SDK walks all blocks from the
 * stored value to current head, which on a public RPC trips rate limits.
 */
function fallbackDeploymentBlock(): number {
  return getNetworkConfig().mode === 'sepolia' ? 10_321_000 : 0
}

let networkConfigPatched = false
let hubNetworkLoaded = false

function patchNetworkConfig(
  networkConfig: Record<string, Record<string, unknown>>,
  privacyPoolAddress: string,
  relayAdaptContract: string | undefined,
  deployBlock: number,
): void {
  if (networkConfigPatched) return

  const target = networkConfig[RAILGUN_NETWORK_KEY]
  if (!target) {
    throw new Error(`[railgun.network] SDK NETWORK_CONFIG is missing the "${RAILGUN_NETWORK_KEY}" entry`)
  }

  target.proxyContract = privacyPoolAddress
  target.relayAdaptContract = relayAdaptContract ?? ethers.ZeroAddress
  target.relayAdaptHistory = relayAdaptContract ? [relayAdaptContract] : ['']
  target.deploymentBlock = deployBlock
  target.poseidonMerkleAccumulatorV3Contract = ethers.ZeroAddress
  target.poseidonMerkleVerifierV3Contract = ethers.ZeroAddress
  target.tokenVaultV3Contract = ethers.ZeroAddress
  target.deploymentBlockPoseidonMerkleAccumulatorV3 = 0
  target.supportsV3 = false
  target.poi = undefined

  if (getNetworkConfig().mode === 'sepolia') {
    const hubChainId = getNetworkConfig().hub.chainId
    target.chain = { type: 0, id: hubChainId }
    // Neutralize the real Ethereum_Sepolia entry so `networkForChain({type:0, id:11155111})`
    // resolves to our patched Hardhat entry, not the real one. If we didn't do this, the SDK
    // would try to call its built-in QuickSync against the real Railgun deployment.
    const sepoliaEntry = networkConfig['Ethereum_Sepolia']
    if (sepoliaEntry) sepoliaEntry.chain = { type: 0, id: -1 }
  }

  networkConfigPatched = true
}

/**
 * Load the hub network into the SDK's provider registry. Idempotent: subsequent calls return
 * immediately. Must run after `startRailgunEngine` (which `initRailgun` handles).
 *
 * Throws when the deployment manifest is missing a `privacyPool` address or when the configured
 * RPC URL has no PrivacyPool code (typically: Anvil isn't running, contracts not deployed).
 */
export async function loadHubNetwork(): Promise<void> {
  if (hubNetworkLoaded) return

  const [{ loadProvider }, { NETWORK_CONFIG, NetworkName }] = await Promise.all([
    railgunWalletSdk(),
    railgunSharedModels(),
  ])

  const deployments = await loadDeployments()
  const hubChainId = getNetworkConfig().hub.chainId
  const hubChain = getNetworkConfig().hub
  const privacyPool = deployments.hub.contracts.privacyPool
  if (!privacyPool) {
    throw new Error('[railgun.network] hub deployment is missing contracts.privacyPool')
  }

  // We don't currently surface a yield adapter through the new app's deployment schema; pass
  // ZeroAddress for the relayAdapt entry. When the Yield modal needs adapt-based proofs we'll
  // wire the address through deployments.ts and re-patch here.
  //
  // Deploy block: prefer the manifest field (recorded by deploy_privacy_pool.ts at deploy time),
  // fall back to a hardcoded sepolia value for older manifests. The SDK reads this via
  // NETWORK_CONFIG.<name>.deploymentBlock to bound the initial historical scan.
  const deployBlock = deployments.hub.deployBlock ?? fallbackDeploymentBlock()
  patchNetworkConfig(
    NETWORK_CONFIG as unknown as Record<string, Record<string, unknown>>,
    privacyPool,
    undefined,
    deployBlock,
  )

  // Sanity check: the configured RPC must respond with PrivacyPool bytecode at the expected
  // address. Cheap up-front check — saves a much more confusing error later when the SDK tries
  // to scan events from an empty contract.
  const primaryRpc = hubChain.rpcUrls[0]
  if (!primaryRpc) {
    throw new Error('[railgun.network] hub chain has no configured RPC URLs')
  }
  const provider = timeoutProvider(primaryRpc)
  const code = await provider.getCode(privacyPool)
  if (!code || code === '0x') {
    throw new Error(
      `[railgun.network] no PrivacyPool code at ${privacyPool} on ${primaryRpc}. ` +
        'Run `npm run chains` + `npm run setup` from the repo root.',
    )
  }

  // Provider config — the SDK's FallbackProvider rotates across these on error (P1-18). Each
  // configured hub RPC URL becomes an entry; the first is priority 1 (preferred), extras are
  // priority 2+ so they only serve when the primary errors/stalls. weight 2 satisfies the SDK's
  // quorum check; stallTimeout differs by network — testnet RPCs are slower / chattier.
  const stallTimeout = getNetworkConfig().mode === 'sepolia' ? 10_000 : 2_500
  const fallbackConfig = {
    chainId: hubChainId,
    providers: hubChain.rpcUrls.map((url, i) => ({
      provider: url,
      priority: i + 1,
      weight: 2,
      maxLogsPerBatch: 10,
      stallTimeout,
    })),
  }

  await loadProvider(fallbackConfig, NetworkName.Hardhat, sdkPollIntervalMs())
  hubNetworkLoaded = true
}

export function isHubNetworkLoaded(): boolean {
  return hubNetworkLoaded
}

/** Reset state — primarily for tests + dev hot-reload scenarios. */
export function resetNetworkLoaderState(): void {
  hubNetworkLoaded = false
  networkConfigPatched = false
}

/** The SDK-facing chain descriptor for the hub. Used by callers building tx contexts. */
export function getHubChainDescriptor(): { type: 0; id: number } {
  return { type: 0, id: getNetworkConfig().hub.chainId }
}

/**
 * Fetch the current block number on the hub chain. Used at wallet enroll to seed the
 * Railgun SDK's `creationBlockNumbers` — tells the engine "this wallet didn't exist before
 * block N, skip decryption attempts on commitments older than that."
 *
 * Spins up a one-shot JsonRpcProvider. Cheap; not worth caching since the result changes.
 */
export async function getCurrentHubBlock(): Promise<number | null> {
  const hubChain = getNetworkConfig().hub
  const primaryRpc = hubChain.rpcUrls[0]
  if (!primaryRpc) return null
  try {
    const provider = timeoutProvider(primaryRpc)
    return await provider.getBlockNumber()
  } catch {
    // Non-fatal — wallet enroll proceeds without creationBlockNumbers, engine just does
    // slightly more decryption work on the first scan. No correctness impact.
    return null
  }
}

/**
 * Look up the chain timestamp (seconds since epoch) for one or more hub-chain block numbers.
 * Used by `runHistoryScan` to backfill timestamps on SDK history items where the SDK didn't
 * populate `item.timestamp` itself (observed on local Anvil chains and some RPC providers).
 *
 * Deduplicates input block numbers — N items sharing one block produce one RPC call. Results
 * are returned as a `Map<blockNumber, timestampSeconds>`; missing entries mean the lookup
 * failed and the caller should keep its existing (possibly zero) timestamp.
 */
export async function getHubBlockTimestamps(
  blockNumbers: ReadonlyArray<number>,
): Promise<Map<number, number>> {
  const result = new Map<number, number>()
  if (blockNumbers.length === 0) return result
  const hubChain = getNetworkConfig().hub
  const primaryRpc = hubChain.rpcUrls[0]
  if (!primaryRpc) return result
  // Dedup before issuing RPC calls — first-scan recovery on a busy wallet can hit dozens of
  // items spread across a few blocks, and `eth_getBlockByNumber` is one of the more expensive
  // public-RPC reads.
  const unique = Array.from(new Set(blockNumbers))
  const provider = timeoutProvider(primaryRpc)
  const blocks = await Promise.allSettled(
    unique.map((bn) => provider.getBlock(bn)),
  )
  for (let i = 0; i < unique.length; i++) {
    const settled = blocks[i]
    const blockNumber = unique[i]
    if (settled?.status === 'fulfilled' && settled.value && blockNumber !== undefined) {
      result.set(blockNumber, settled.value.timestamp)
    }
  }
  return result
}
