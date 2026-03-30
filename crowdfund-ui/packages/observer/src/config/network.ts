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

export function getHubChainId(): number {
  return isLocalMode() ? 31337 : 11155111
}

export function getDeploymentFileName(): string {
  return isLocalMode() ? 'crowdfund-hub.json' : 'crowdfund-hub-sepolia.json'
}

/** Polling intervals: faster for local, slower for testnet */
export function getPollIntervalMs(): number {
  return isLocalMode() ? 5_000 : 15_000
}
