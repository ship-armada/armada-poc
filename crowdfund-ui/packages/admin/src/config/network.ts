// ABOUTME: Network configuration for local (Anvil) and Sepolia modes.
// ABOUTME: Reads VITE_NETWORK env var to determine active network.

export type NetworkMode = 'local' | 'sepolia'

export function getNetworkMode(): NetworkMode {
  const env = import.meta.env.VITE_NETWORK as string | undefined
  if (env === 'sepolia') return 'sepolia'
  return 'local'
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

export function getHubChainId(): number {
  return isLocalMode() ? 31337 : 11155111
}

/**
 * Returns the path (relative to the Vite serveDeployments middleware in dev, or
 * the static asset path in production) of the crowdfund deployment manifest.
 *
 * Local mode → `crowdfund-hub.json` (written by `npm run setup`).
 * Sepolia + `VITE_DEPLOYMENT_INSTANCE=<name>` → mirrored path under
 *   `instances/<name>/sepolia/crowdfund.json`, populated by the Netlify build
 *   step (curl from armada-deployments) or `npm run fetch-deployment -- <name>`.
 * Sepolia, no instance set → legacy `crowdfund-hub-sepolia.json` (whatever the
 *   local `deployments/` folder currently holds — overwritten by `setup:sepolia`).
 */
export function getDeploymentFileName(): string {
  if (isLocalMode()) return 'crowdfund-hub.json'
  const instance = (import.meta.env.VITE_DEPLOYMENT_INSTANCE as string | undefined)?.trim()
  if (instance) return `instances/${instance}/sepolia/crowdfund.json`
  return 'crowdfund-hub-sepolia.json'
}

/** Optional indexer API base URL. When provided, the admin's events hook prefers
 *  indexed snapshots over backfilling from RPC on first load. */
export function getIndexerUrl(): string | null {
  return (import.meta.env.VITE_CROWDFUND_INDEXER_URL as string | undefined) ?? null
}

export function getPollIntervalMs(): number {
  return isLocalMode() ? 5_000 : 15_000
}

/** Block explorer base URL. Returns undefined for local mode (no explorer). */
export function getExplorerUrl(): string | undefined {
  if (isLocalMode()) return undefined
  return 'https://sepolia.etherscan.io'
}
