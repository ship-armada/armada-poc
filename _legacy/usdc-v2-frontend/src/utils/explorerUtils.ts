/**
 * Utilities for building blockchain explorer URLs.
 */

import { fetchEvmChainsConfig } from '@/services/config/chainConfigService'
import { findChainByKey } from '@/config/chains'
import type { EvmChainsFile } from '@/config/chains'

let cachedEvmConfig: EvmChainsFile | null = null

/**
 * Get cached or fetch EVM chains configuration.
 */
async function getEvmChainsConfig(): Promise<EvmChainsFile | null> {
  if (cachedEvmConfig) {
    return cachedEvmConfig
  }

  try {
    cachedEvmConfig = await fetchEvmChainsConfig()
    return cachedEvmConfig
  } catch (error) {
    console.warn('[explorerUtils] Failed to fetch EVM chains config:', error)
    return null
  }
}

/**
 * Get Namada transaction explorer URL for a given transaction hash.
 * NOTE: Namada chain support has been removed. Returns undefined.
 */
export async function getNamadaTxExplorerUrl(_txHash: string): Promise<string | undefined> {
  return undefined
}

/**
 * Get EVM transaction explorer URL for a given chain key and transaction hash.
 *
 * @param chainKey - The EVM chain key (e.g., 'sepolia', 'base-sepolia')
 * @param txHash - The transaction hash (will be lowercased)
 * @returns The explorer URL, or undefined if chain config is not available
 */
export async function getEvmTxExplorerUrl(chainKey: string, txHash: string): Promise<string | undefined> {
  const lowercasedHash = txHash.toLowerCase()
  const evmConfig = await getEvmChainsConfig()

  if (!evmConfig) {
    return undefined
  }

  const chain = findChainByKey(evmConfig, chainKey)

  if (!chain?.explorer?.baseUrl) {
    return undefined
  }

  const txPath = chain.explorer.txPath ?? 'tx'
  return `${chain.explorer.baseUrl}/${txPath}/${lowercasedHash}`
}

/**
 * Get Noble transaction explorer URL for a given transaction hash.
 * NOTE: Noble chain support has been removed. Returns undefined.
 */
export async function getNobleTxExplorerUrl(_txHash: string): Promise<string | undefined> {
  return undefined
}

/**
 * Synchronous explorer URL builder that accepts configs as parameters.
 * Use this when you already have the chain configs loaded (e.g., in components).
 *
 * @param value - The value to build URL for (address, tx hash, or block height)
 * @param type - The type of URL to build ('address', 'tx', or 'block')
 * @param chainType - The chain type ('evm', 'namada', or 'noble')
 * @param chainKey - Optional chain key (required for EVM chains)
 * @param evmChainsConfig - EVM chains configuration (required for EVM chains)
 * @returns The explorer URL, or undefined if chain config is not available
 */
export function buildExplorerUrlSync(
  value: string,
  type: 'address' | 'tx' | 'block',
  chainType: 'evm' | 'namada' | 'noble',
  chainKey: string | undefined,
  evmChainsConfig: EvmChainsFile | null,
): string | undefined {
  // Noble and Namada chain support has been removed
  if (chainType === 'namada' || chainType === 'noble') {
    return undefined
  }

  if (type === 'address') {
    if (chainType === 'evm') {
      const chain = chainKey && evmChainsConfig ? findChainByKey(evmChainsConfig, chainKey) : null
      if (chain?.explorer?.baseUrl) {
        const addressPath = chain.explorer.addressPath ?? 'address'
        return `${chain.explorer.baseUrl}/${addressPath}/${value}`
      }
    }
  } else if (type === 'tx') {
    const lowercasedHash = value.toLowerCase()
    if (chainType === 'evm') {
      const chain = chainKey && evmChainsConfig ? findChainByKey(evmChainsConfig, chainKey) : null
      if (chain?.explorer?.baseUrl) {
        const txPath = chain.explorer.txPath ?? 'tx'
        return `${chain.explorer.baseUrl}/${txPath}/${lowercasedHash}`
      }
    }
  } else if (type === 'block') {
    // Block explorer URLs
    if (chainType === 'evm') {
      const chain = chainKey && evmChainsConfig ? findChainByKey(evmChainsConfig, chainKey) : null
      if (chain?.explorer?.baseUrl) {
        const blockPath = chain.explorer.blockPath ?? 'block'
        return `${chain.explorer.baseUrl}/${blockPath}/${value}`
      }
    }
  }
  return undefined
}
