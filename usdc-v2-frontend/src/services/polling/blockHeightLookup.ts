/**
 * Block Height Lookup Service
 *
 * Provides abstracted methods to fetch block height from creation timestamp for different chains.
 * Each chain implements its own lookup method, but all provide the same interface:
 * getStartHeight(chainKey, creationTimestampMs, blockWindowBackscan) -> startHeight
 */

import { logger } from '@/utils/logger'
import { fetchEvmChainsConfig } from '@/services/config/chainConfigService'
import { getEvmProvider } from '@/services/evm/evmNetworkService'

/**
 * Cache for chain configs
 */
let evmConfigsCache: Awaited<ReturnType<typeof fetchEvmChainsConfig>> | null = null

/**
 * Default block window backscan values (blocks to scan backwards)
 * Used as fallback if not specified in chain config
 */
const DEFAULT_BLOCK_WINDOW_BACKSCAN: Record<string, number> = {
  'namada-testnet': 20,
  'noble-testnet': 50,
  'sepolia': 50,
  'ethereum': 50,
  // Add more defaults as needed
}

/**
 * Get block window backscan for a chain from config files
 *
 * @param chainKey - Chain key (e.g., 'sepolia')
 * @returns Block window backscan value
 */
async function getBlockWindowBackscan(chainKey: string): Promise<number> {
  try {
    // Check EVM chains
    if (!evmConfigsCache) {
      evmConfigsCache = await fetchEvmChainsConfig()
    }

    const evmChain = evmConfigsCache.chains.find((c) => c.key === chainKey)
    if (evmChain?.pollingConfig?.blockWindowBackscan !== undefined) {
      return evmChain.pollingConfig.blockWindowBackscan
    }

    // Fallback to defaults
    return DEFAULT_BLOCK_WINDOW_BACKSCAN[chainKey] ?? 50
  } catch (error) {
    logger.warn('[BlockHeightLookup] Failed to load chain config, using default backscan', {
      chainKey,
      error: error instanceof Error ? error.message : String(error),
    })
    // Fallback to defaults
    return DEFAULT_BLOCK_WINDOW_BACKSCAN[chainKey] ?? 50
  }
}

/**
 * Namada-specific block height lookup
 * NOTE: Namada chain support has been removed. This returns a stub.
 */
async function getNamadaStartHeight(
  _creationTimestampMs: number,
  _blockWindowBackscan: number,
): Promise<number> {
  logger.error('[BlockHeightLookup] Namada chain support has been removed')
  throw new Error('Namada chain support has been removed from this version')
}

/**
 * Noble-specific block height lookup
 * NOTE: Noble chain support has been removed. This returns a stub.
 */
async function getNobleStartHeight(
  _creationTimestampMs: number,
  _blockWindowBackscan: number,
): Promise<number> {
  logger.error('[BlockHeightLookup] Noble chain support has been removed')
  throw new Error('Noble chain support has been removed from this version')
}

/**
 * EVM-specific block height lookup using ethers provider
 *
 * @param chainKey - Chain key (e.g., 'sepolia', 'ethereum')
 * @param creationTimestampMs - Creation timestamp in milliseconds
 * @param blockWindowBackscan - Number of blocks to scan backwards
 * @returns Start height for polling
 */
async function getEvmStartHeight(
  chainKey: string,
  creationTimestampMs: number,
  blockWindowBackscan: number,
): Promise<number> {
  const provider = await getEvmProvider(chainKey)
  const currentBlock = await provider.getBlockNumber()

  // Convert timestamp to seconds
  const timestampSeconds = Math.floor(creationTimestampMs / 1000)

  // Estimate based on average block time (12 seconds for most EVM chains)
  const avgBlockTimeSeconds = 12
  const nowSeconds = Math.floor(Date.now() / 1000)
  const secondsAgo = nowSeconds - timestampSeconds
  const blocksAgo = Math.floor(secondsAgo / avgBlockTimeSeconds)
  const estimatedStartBlock = Math.max(1, currentBlock - blocksAgo - blockWindowBackscan)

  logger.debug('[BlockHeightLookup] Using estimated EVM start height', {
    chainKey,
    timestampSeconds,
    currentBlock,
    secondsAgo,
    blocksAgo,
    blockWindowBackscan,
    startHeight: estimatedStartBlock,
  })

  return estimatedStartBlock
}

/**
 * Get start height for polling based on creation timestamp
 *
 * @param chainKey - Chain key (e.g., 'namada-testnet', 'noble-testnet', 'sepolia')
 * @param chainType - Chain type ('evm', 'namada', 'noble')
 * @param creationTimestampMs - Creation timestamp in milliseconds
 * @returns Start height for polling
 */
export async function getStartHeightFromTimestamp(
  chainKey: string,
  chainType: 'evm' | 'namada' | 'noble',
  creationTimestampMs: number,
): Promise<number> {
  const blockWindowBackscan = await getBlockWindowBackscan(chainKey)

  logger.debug('[BlockHeightLookup] Getting start height', {
    chainKey,
    chainType,
    creationTimestampMs,
    blockWindowBackscan,
  })

  switch (chainType) {
    case 'namada':
      return getNamadaStartHeight(creationTimestampMs, blockWindowBackscan)
    case 'noble':
      return getNobleStartHeight(creationTimestampMs, blockWindowBackscan)
    case 'evm':
      return getEvmStartHeight(chainKey, creationTimestampMs, blockWindowBackscan)
    default:
      throw new Error(`Unknown chain type: ${chainType}`)
  }
}
