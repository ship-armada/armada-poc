/**
 * Send Contract Service
 *
 * Low-level contract utilities for send operations.
 * Provides chain configuration and domain mapping for cross-chain transfers.
 */

import {
  getChainToDomain as getChainToDomainMap,
  getRelayerAddress,
  getAllDestinationChains as getAllDestsFromConfig,
} from '@/config/networkConfig'

// Chain ID to CCTP domain mapping (from network config)
const CHAIN_TO_DOMAIN = getChainToDomainMap()

// Default relayer address (from network config)
export const DEFAULT_RELAYER_ADDRESS = getRelayerAddress()

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
  return getAllDestsFromConfig()
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
