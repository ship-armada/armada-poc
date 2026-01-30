/**
 * Send Contract Service
 *
 * Low-level contract utilities for send operations.
 * Provides chain configuration and domain mapping for cross-chain transfers.
 */

// Chain ID to CCTP domain mapping (matches CCTPDomains library in contracts)
const CHAIN_TO_DOMAIN: Record<number, number> = {
  31337: 100, // Hub
  31338: 101, // Client A
  31339: 102, // Client B
}

// Default relayer address (first Hardhat account - used for local devnet)
export const DEFAULT_RELAYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/**
 * Get CCTP domain for a chain ID
 */
export function getChainToDomain(chainId: number): number {
  const domain = CHAIN_TO_DOMAIN[chainId]
  if (domain === undefined) {
    throw new Error(`Unknown chain ID: ${chainId}. No CCTP domain mapping.`)
  }
  return domain
}

/**
 * Get all destination chains for unshield
 */
export function getAllDestinationChains(): {
  key: string
  chainId: number
  name: string
  isHub: boolean
}[] {
  return [
    { key: 'hub', chainId: 31337, name: 'Hub', isHub: true },
    { key: 'client-a', chainId: 31338, name: 'Client Chain A', isHub: false },
    { key: 'client-b', chainId: 31339, name: 'Client Chain B', isHub: false },
  ]
}

/**
 * Get chain info by key
 */
export function getChainByKey(key: string): {
  chainId: number
  name: string
  isHub: boolean
} | null {
  const chains = getAllDestinationChains()
  return chains.find((c) => c.key === key) || null
}

/**
 * Check if a chain key is the hub chain
 */
export function isHubChain(chainKey: string): boolean {
  return chainKey === 'hub'
}
