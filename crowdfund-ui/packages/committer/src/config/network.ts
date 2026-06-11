// ABOUTME: Network configuration for local (Anvil) and Sepolia modes.
// ABOUTME: Reads VITE_NETWORK env var to determine active network.

export type NetworkMode = 'local' | 'sepolia'

export function getNetworkMode(): NetworkMode {
  const env = import.meta.env.VITE_NETWORK as string | undefined
  if (env === 'sepolia') return 'sepolia'
  if (env === 'local') return 'local'
  // No explicit network. A production bundle must never silently fall back to
  // local (which points at localhost:8545) — default unset to sepolia in PROD.
  // (Startup validateEnv() hard-fails such a build before render anyway.)
  // Dev keeps the local default.
  return import.meta.env.PROD ? 'sepolia' : 'local'
}

export function isLocalMode(): boolean {
  return getNetworkMode() === 'local'
}

export function getHubRpcUrl(): string {
  if (isLocalMode()) return 'http://localhost:8545'
  return (import.meta.env.VITE_SEPOLIA_RPC as string) || 'https://ethereum-sepolia-rpc.publicnode.com'
}

/** Ordered list of RPC URLs for fallback. Primary URL first. */
export function getHubRpcUrls(): string[] {
  if (isLocalMode()) return ['http://localhost:8545']
  const primary = (import.meta.env.VITE_SEPOLIA_RPC as string) || 'https://ethereum-sepolia-rpc.publicnode.com'
  const fallback = (import.meta.env.VITE_SEPOLIA_RPC_FALLBACK as string) || undefined
  return fallback ? [primary, fallback] : [primary]
}

export function getIndexerUrl(): string | null {
  if (isLocalMode()) return null
  return (import.meta.env.VITE_CROWDFUND_INDEXER_URL as string | undefined) ?? null
}

export function getHubChainId(): number {
  return isLocalMode() ? 31337 : 11155111
}

/**
 * Returns the path (relative to the Vite serveDeployments middleware) of the
 * crowdfund deployment manifest to load.
 *
 * Local mode → `crowdfund-hub.json` (written by `npm run setup`).
 * Sepolia + `VITE_DEPLOYMENT_INSTANCE=<name>` → mirrored path under
 *   `instances/<name>/sepolia/crowdfund.json`, populated by
 *   `npm run fetch-deployment -- <name>` from the armada-deployments repo.
 * Sepolia, no instance set → legacy `crowdfund-hub-sepolia.json` (whatever the
 *   local `deployments/` folder currently holds — overwritten by `setup:sepolia`).
 */
export function getDeploymentFileName(): string {
  if (isLocalMode()) return 'crowdfund-hub.json'
  const instance = (import.meta.env.VITE_DEPLOYMENT_INSTANCE as string | undefined)?.trim()
  if (instance) return `instances/${instance}/sepolia/crowdfund.json`
  return 'crowdfund-hub-sepolia.json'
}

export function getPollIntervalMs(): number {
  return isLocalMode() ? 5_000 : 15_000
}

/**
 * Max blocks per eth_getLogs request. Local Anvil is tiny so 10 is plenty;
 * Sepolia public RPCs (publicnode) handle far larger ranges, so use a wide
 * range to keep cold-start backfills from taking thousands of requests.
 * fetchLogs halves this on a range-too-large error, so an over-estimate is safe.
 */
export function getMaxBlockRange(): number {
  return isLocalMode() ? 10 : 2_000
}

/** Block explorer base URL. Returns undefined for local mode (no explorer). */
export function getExplorerUrl(): string | undefined {
  if (isLocalMode()) return undefined
  return 'https://sepolia.etherscan.io'
}
