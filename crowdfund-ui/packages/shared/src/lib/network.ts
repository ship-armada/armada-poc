// ABOUTME: Shared network configuration for local (Anvil), Sepolia, and mainnet.
// ABOUTME: Pure resolvers (testable) + import.meta.env wrappers used by the apps.

import { getAddress } from 'ethers'

export type NetworkMode = 'local' | 'sepolia' | 'mainnet'

/** The subset of Vite env the network resolvers read. All optional so the pure
 *  resolvers can be exercised with plain records in tests. */
export interface NetworkEnv {
  PROD?: boolean
  VITE_NETWORK?: string
  /** Canonical hub RPC for the active non-local network (mainnet or sepolia). */
  VITE_HUB_RPC?: string
  VITE_HUB_RPC_FALLBACK?: string
  /** Legacy Sepolia-specific RPC names. Read only in sepolia mode for backward
   *  compatibility with deploys configured before the VITE_HUB_RPC rename. */
  VITE_SEPOLIA_RPC?: string
  VITE_SEPOLIA_RPC_FALLBACK?: string
  VITE_CROWDFUND_INDEXER_URL?: string
  VITE_DEPLOYMENT_INSTANCE?: string
  /** Trusted crowdfund address supplied out-of-band from the mainnet deploy
   *  output. Used to verify the fetched manifest's crowdfund (USDC approve/commit
   *  target) address against a value that does not come from armada-deployments. */
  VITE_EXPECTED_CROWDFUND_ADDRESS?: string
}

// Default public RPCs, used only when no env-configured URL is present. A money
// app should set a dedicated provider (see VITE_HUB_RPC); these are last-resort
// fallbacks so a missing env var degrades to a working endpoint rather than none.
const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const DEFAULT_MAINNET_RPC = 'https://ethereum-rpc.publicnode.com'

const CHAIN_ID: Record<NetworkMode, number> = {
  local: 31337,
  sepolia: 11155111,
  mainnet: 1,
}

/**
 * Resolve the active network mode from the env.
 *
 * Explicit `VITE_NETWORK` wins. When unset, dev defaults to local; a production
 * bundle defaults to sepolia — never local (which points at localhost:8545) and
 * never mainnet (which must be an explicit, deliberate opt-in). A PROD build with
 * an unset/blank network is itself a misconfiguration that the apps' startup
 * validation surfaces loudly.
 */
export function resolveNetworkMode(env: NetworkEnv): NetworkMode {
  const value = env.VITE_NETWORK?.trim()
  if (value === 'mainnet') return 'mainnet'
  if (value === 'sepolia') return 'sepolia'
  if (value === 'local') return 'local'
  return env.PROD ? 'sepolia' : 'local'
}

export function isLocalNetwork(mode: NetworkMode): boolean {
  return mode === 'local'
}

export function chainIdForMode(mode: NetworkMode): number {
  return CHAIN_ID[mode]
}

/**
 * Human-readable name of the deployment's chain, derived from the chain id so it
 * stays correct across environments without hardcoding a network into UI copy.
 */
export function networkLabelForChainId(chainId: number): string {
  switch (chainId) {
    case 1:
      return 'Ethereum'
    case 11155111:
      return 'Sepolia'
    case 31337:
      return 'the local network'
    default:
      return 'the correct network'
  }
}

/** Ordered list of RPC URLs for fallback. Primary URL first. */
export function resolveHubRpcUrls(env: NetworkEnv): string[] {
  const mode = resolveNetworkMode(env)
  if (mode === 'local') return ['http://localhost:8545']

  // VITE_HUB_RPC is the canonical name. In sepolia mode we also honour the legacy
  // VITE_SEPOLIA_RPC names so deploys configured before the rename keep working;
  // we deliberately do NOT read those on mainnet (a sepolia URL on mainnet would
  // silently target the wrong chain).
  const legacyPrimary = mode === 'sepolia' ? env.VITE_SEPOLIA_RPC : undefined
  const legacyFallback = mode === 'sepolia' ? env.VITE_SEPOLIA_RPC_FALLBACK : undefined
  const defaultRpc = mode === 'mainnet' ? DEFAULT_MAINNET_RPC : DEFAULT_SEPOLIA_RPC

  const primary = env.VITE_HUB_RPC || legacyPrimary || defaultRpc
  const fallback = env.VITE_HUB_RPC_FALLBACK || legacyFallback || undefined
  return fallback ? [primary, fallback] : [primary]
}

export function resolveIndexerUrl(env: NetworkEnv): string | null {
  if (resolveNetworkMode(env) === 'local') return null
  return env.VITE_CROWDFUND_INDEXER_URL ?? null
}

/**
 * Path (relative to the apps' deployment-manifest middleware) of the crowdfund
 * deployment manifest to load.
 *
 * Local → `crowdfund-hub.json`.
 * Non-local + `VITE_DEPLOYMENT_INSTANCE=<name>` → mirrored path under
 *   `instances/<name>/<mode>/crowdfund.json` (mode is `sepolia` or `mainnet`),
 *   populated by `npm run fetch-deployment` from the armada-deployments repo.
 * Non-local, no instance → legacy `crowdfund-hub-<mode>.json`.
 */
export function resolveDeploymentFileName(env: NetworkEnv): string {
  const mode = resolveNetworkMode(env)
  if (mode === 'local') return 'crowdfund-hub.json'
  const instance = env.VITE_DEPLOYMENT_INSTANCE?.trim()
  if (instance) return `instances/${instance}/${mode}/crowdfund.json`
  return `crowdfund-hub-${mode}.json`
}

export function pollIntervalForMode(mode: NetworkMode): number {
  return mode === 'local' ? 5_000 : 15_000
}

/**
 * Max blocks per eth_getLogs request. Local Anvil is tiny so 10 is plenty; public
 * RPCs handle far larger ranges, so use a wide range to keep cold-start backfills
 * from taking thousands of requests. fetchLogs halves this on a range-too-large
 * error, so an over-estimate is safe.
 */
export function maxBlockRangeForMode(mode: NetworkMode): number {
  return mode === 'local' ? 10 : 2_000
}

/**
 * Confirmations to await before treating a transaction as terminally successful.
 * Deeper on mainnet so a single-block reorg can't surface a dropped tx as
 * confirmed (showing "done" for a commit that never landed). Instant local chains
 * and the low-stakes testnet stay at 1. Keep this small enough that
 * confirmations × ~12s stays well within the tx-wait timeout.
 */
export function confirmationsForMode(mode: NetworkMode): number {
  return mode === 'mainnet' ? 2 : 1
}

/**
 * Guard a loaded deployment manifest against the build's target chain. Throws on
 * mismatch so a build can never silently use one network's contract addresses on
 * another (e.g. a mainnet site accidentally fed a Sepolia manifest) — the wallet
 * would expect chain X while the app talked to chain-Y addresses.
 */
export function assertDeploymentChainId(
  manifestChainId: number,
  expectedChainId: number,
  source: string,
): void {
  if (manifestChainId !== expectedChainId) {
    throw new Error(
      `Deployment chain mismatch: ${source} is for chain ${manifestChainId}, but this ` +
        `build targets chain ${expectedChainId}. Check VITE_NETWORK / VITE_DEPLOYMENT_INSTANCE.`,
    )
  }
}

/**
 * Guard a loaded deployment manifest's critical address against an out-of-band
 * expected value. Defends against a compromised/wrong manifest (supply-chain gap
 * on the armada-deployments fetch) redirecting the USDC approve/commit target.
 * Case/checksum-insensitive. Throws on mismatch or a malformed input.
 */
export function assertExpectedAddress(
  actual: string,
  expected: string,
  field: string,
  source: string,
): void {
  let a: string
  let e: string
  try {
    a = getAddress(actual)
    e = getAddress(expected)
  } catch {
    throw new Error(`Address integrity check failed for ${field} in ${source}: malformed address`)
  }
  if (a !== e) {
    throw new Error(
      `Address integrity check failed: ${field} in ${source} is ${a}, but this build expects ${e}. ` +
        `Refusing to load — possible supply-chain tampering of the deployment manifest.`,
    )
  }
}

/** Block explorer base URL. Returns undefined for local mode (no explorer). */
export function explorerUrlForMode(mode: NetworkMode): string | undefined {
  switch (mode) {
    case 'mainnet':
      return 'https://etherscan.io'
    case 'sepolia':
      return 'https://sepolia.etherscan.io'
    case 'local':
      return undefined
  }
}

// --- import.meta.env wrappers -------------------------------------------------
// These read the live Vite env. Each app's bundler statically replaces
// import.meta.env at build, so the resolvers above stay pure and unit-testable.

function env(): NetworkEnv {
  return import.meta.env as unknown as NetworkEnv
}

export function getNetworkMode(): NetworkMode {
  return resolveNetworkMode(env())
}

export function isLocalMode(): boolean {
  return isLocalNetwork(getNetworkMode())
}

export function getHubChainId(): number {
  return chainIdForMode(getNetworkMode())
}

export function getHubNetworkLabel(): string {
  return networkLabelForChainId(getHubChainId())
}

export function getHubRpcUrl(): string {
  return resolveHubRpcUrls(env())[0]
}

export function getHubRpcUrls(): string[] {
  return resolveHubRpcUrls(env())
}

export function getIndexerUrl(): string | null {
  return resolveIndexerUrl(env())
}

export function getDeploymentFileName(): string {
  return resolveDeploymentFileName(env())
}

export function getPollIntervalMs(): number {
  return pollIntervalForMode(getNetworkMode())
}

export function getMaxBlockRange(): number {
  return maxBlockRangeForMode(getNetworkMode())
}

export function getTxConfirmations(): number {
  return confirmationsForMode(getNetworkMode())
}

export function getExplorerUrl(): string | undefined {
  return explorerUrlForMode(getNetworkMode())
}

export function getExpectedCrowdfundAddress(): string | undefined {
  return env().VITE_EXPECTED_CROWDFUND_ADDRESS?.trim() || undefined
}
