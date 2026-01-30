/**
 * Chain resolution and display name utilities.
 * Centralized functions for resolving chain keys and display names across components.
 */

import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import type { EvmChainsFile } from '@/config/chains'
import { findChainByKey } from '@/config/chains'

/**
 * Get EVM chain key from chain name or transaction chain.
 * 
 * @param chainName - The chain name (display name or key)
 * @param transactionChain - The transaction chain key (fallback)
 * @param evmChainsConfig - The EVM chains configuration
 * @returns The resolved chain key, or undefined if not found
 */
export function getEvmChainKey(
  chainName: string | undefined,
  transactionChain: string | undefined,
  evmChainsConfig: EvmChainsFile | null
): string | undefined {
  if (!evmChainsConfig) return transactionChain

  // First try to find by chain name (case-insensitive)
  if (chainName) {
    const normalizedName = chainName.toLowerCase().replace(/\s+/g, '-')
    const foundByNormalized = evmChainsConfig.chains.find(
      chain => chain.key.toLowerCase() === normalizedName
    )
    if (foundByNormalized) return foundByNormalized.key

    // Try to find by display name
    const foundByName = evmChainsConfig.chains.find(
      chain => chain.name.toLowerCase() === chainName.toLowerCase()
    )
    if (foundByName) return foundByName.key
  }

  // Fallback to transaction chain if it looks like a valid key
  if (transactionChain) {
    const foundByChain = evmChainsConfig.chains.find(
      chain => chain.key === transactionChain
    )
    if (foundByChain) return foundByChain.key
  }

  return transactionChain
}

/**
 * Get chain display name from chain key ('evm', 'noble', 'namada').
 * 
 * @param chainKey - The chain key ('evm', 'noble', or 'namada')
 * @param transaction - The transaction to get chain details from
 * @param evmChainsConfig - The EVM chains configuration (required for EVM chains)
 * @returns The display name for the chain
 */
export function getChainDisplayName(
  chainKey: 'evm' | 'noble' | 'namada',
  transaction: StoredTransaction,
  evmChainsConfig: EvmChainsFile | null
): string {
  if (chainKey === 'noble') {
    return 'Noble'
  }
  if (chainKey === 'namada') {
    return 'Namada'
  }
  // For EVM, get the actual chain name from transaction details
  if (chainKey === 'evm') {
    const chainName = transaction.depositDetails?.chainName || transaction.paymentDetails?.chainName
    if (chainName && evmChainsConfig) {
      // Try to find chain by name
      const chain = evmChainsConfig.chains.find(
        c => c.name.toLowerCase() === chainName.toLowerCase() || c.key === chainName
      )
      if (chain) {
        return chain.name
      }
      // If not found, return the chainName as-is (might already be display name)
      return chainName
    }
    // Fallback: try to get from transaction.chain
    if (transaction.chain && evmChainsConfig) {
      const chain = findChainByKey(evmChainsConfig, transaction.chain)
      if (chain) {
        return chain.name
      }
    }
    return 'EVM'
  }
  // All cases handled above, this should never be reached
  return 'Unknown'
}

/**
 * Get source chain name (From chain) for a transaction.
 * 
 * @param transaction - The transaction
 * @param evmChainsConfig - The EVM chains configuration
 * @returns The source chain display name
 */
export function getSourceChainName(
  transaction: StoredTransaction,
  evmChainsConfig: EvmChainsFile | null
): string {
  if (transaction.direction === 'deposit') {
    // For deposits, source is EVM chain
    const chainName = transaction.depositDetails?.chainName || transaction.chain
    if (chainName && evmChainsConfig) {
      const chain = evmChainsConfig.chains.find(
        c => c.name.toLowerCase() === chainName.toLowerCase() || c.key === chainName
      )
      if (chain) {
        return chain.name
      }
      return chainName
    }
    if (transaction.chain && evmChainsConfig) {
      const chain = findChainByKey(evmChainsConfig, transaction.chain)
      if (chain) {
        return chain.name
      }
    }
    return transaction.chain || 'EVM'
  } else {
    // For payments, source is Namada
    return 'Namada'
  }
}

/**
 * Get destination chain name (To chain) for a transaction.
 * 
 * @param transaction - The transaction
 * @param evmChainsConfig - The EVM chains configuration
 * @returns The destination chain display name
 */
export function getDestinationChainName(
  transaction: StoredTransaction,
  evmChainsConfig: EvmChainsFile | null
): string {
  if (transaction.direction === 'deposit') {
    // For deposits, destination is Namada
    return 'Namada'
  } else {
    // For payments, destination is EVM chain
    const chainName = transaction.paymentDetails?.chainName || transaction.chain
    if (chainName && evmChainsConfig) {
      const chain = evmChainsConfig.chains.find(
        c => c.name.toLowerCase() === chainName.toLowerCase() || c.key === chainName
      )
      if (chain) {
        return chain.name
      }
      return chainName
    }
    if (transaction.chain && evmChainsConfig) {
      const chain = findChainByKey(evmChainsConfig, transaction.chain)
      if (chain) {
        return chain.name
      }
    }
    return transaction.chain || 'EVM'
  }
}

/**
 * Get EVM chain logo URL for a transaction.
 * 
 * @param transaction - The transaction
 * @param evmChainsConfig - The EVM chains configuration
 * @returns The logo URL, or undefined if not found
 */
export function getEvmChainLogo(
  transaction: StoredTransaction,
  evmChainsConfig: EvmChainsFile | null
): string | undefined {
  const chainKey = transaction.direction === 'deposit'
    ? getEvmChainKey(transaction.depositDetails?.chainName, transaction.chain, evmChainsConfig)
    : getEvmChainKey(transaction.paymentDetails?.chainName, transaction.chain, evmChainsConfig)
  
  if (chainKey && evmChainsConfig) {
    const chain = findChainByKey(evmChainsConfig, chainKey)
    return chain?.logo
  }
  return undefined
}

/**
 * Get chain display name from a string chain key.
 * This is useful when you have a chain key as a string (e.g., from transaction.chain)
 * rather than the enum type used in getChainDisplayName.
 * 
 * @param chainKey - The chain key as a string (e.g., 'sepolia', 'base-sepolia')
 * @param evmChainsConfig - The EVM chains configuration
 * @returns The display name for the chain, or the chainKey itself if not found
 */
export function getChainDisplayNameFromKey(
  chainKey: string | undefined,
  evmChainsConfig: EvmChainsFile | null
): string {
  if (!chainKey) return ''
  
  // Look up by chain key in evm-chains.json
  if (evmChainsConfig) {
    const resolvedKey = getEvmChainKey(chainKey, chainKey, evmChainsConfig)
    if (resolvedKey) {
      const chain = evmChainsConfig.chains.find(c => c.key === resolvedKey)
      if (chain) {
        return chain.name
      }
    }
    
    // If not found by key, try to find by name (in case chainKey is already a display name)
    const foundByName = evmChainsConfig.chains.find(
      chain => chain.name.toLowerCase() === chainKey.toLowerCase()
    )
    if (foundByName) {
      return foundByName.name
    }
  }
  
  // Fallback to the chain key itself
  return chainKey
}

