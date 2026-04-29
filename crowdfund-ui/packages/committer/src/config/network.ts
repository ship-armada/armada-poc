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

export function getIndexerUrl(): string | null {
  if (isLocalMode()) return null
  return (import.meta.env.VITE_CROWDFUND_INDEXER_URL as string | undefined) ?? null
}

export function getHubChainId(): number {
  return isLocalMode() ? 31337 : 11155111
}

export function getDeploymentFileName(): string {
  return isLocalMode() ? 'crowdfund-hub.json' : 'crowdfund-hub-sepolia.json'
}

export function getPollIntervalMs(): number {
  return isLocalMode() ? 5_000 : 15_000
}

/** Block explorer base URL. Returns undefined for local mode (no explorer). */
export function getExplorerUrl(): string | undefined {
  if (isLocalMode()) return undefined
  return 'https://sepolia.etherscan.io'
}
