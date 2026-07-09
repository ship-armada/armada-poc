/**
 * EVM Block Search Service
 * 
 * Provides binary search functionality to find block height from timestamp.
 * Uses ethers.js provider to query blocks and perform binary search.
 */

import { ethers } from 'ethers'
import { logger } from '@/utils/logger'
import { retryWithBackoff, isAborted } from './basePoller'

/**
 * Cache for genesis block info (rarely changes)
 */
const genesisBlockCache = new Map<string, { number: number; timestamp: number }>()

/**
 * Get genesis block for a chain (cached)
 * 
 * @param provider - EVM provider
 * @param chainKey - Chain key for caching
 * @param abortSignal - Optional abort signal
 * @returns Genesis block number and timestamp
 */
async function getGenesisBlock(
  provider: ethers.JsonRpcProvider,
  chainKey: string,
  abortSignal?: AbortSignal,
): Promise<{ number: number; timestamp: number }> {
  // Check cache first
  if (genesisBlockCache.has(chainKey)) {
    const cached = genesisBlockCache.get(chainKey)!
    logger.debug('[EvmBlockSearch] Using cached genesis block', {
      chainKey,
      blockNumber: cached.number,
      timestamp: cached.timestamp,
    })
    return cached
  }

  logger.debug('[EvmBlockSearch] Fetching genesis block', {
    chainKey,
  })

  try {
    // Get block 0 (genesis block)
    const genesisBlock = await retryWithBackoff(
      () => provider.getBlock(0),
      3,
      500,
      5000,
      abortSignal,
    )

    if (!genesisBlock) {
      throw new Error('Genesis block not found')
    }

    const genesisInfo = {
      number: genesisBlock.number,
      timestamp: genesisBlock.timestamp,
    }

    // Cache it
    genesisBlockCache.set(chainKey, genesisInfo)

    logger.info('[EvmBlockSearch] Genesis block fetched and cached', {
      chainKey,
      blockNumber: genesisInfo.number,
      timestamp: genesisInfo.timestamp,
    })

    return genesisInfo
  } catch (error) {
    logger.error('[EvmBlockSearch] Failed to fetch genesis block', {
      chainKey,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Binary search to find block number closest to (but not after) target timestamp
 * 
 * @param provider - EVM provider
 * @param targetTimestampMs - Target timestamp in milliseconds
 * @param chainKey - Chain key for caching and logging
 * @param abortSignal - Optional abort signal
 * @returns Block number closest to target timestamp
 */
export async function binarySearchBlockByTimestamp(
  provider: ethers.JsonRpcProvider,
  targetTimestampMs: number,
  chainKey: string,
  abortSignal?: AbortSignal,
): Promise<number> {
  const targetTimestamp = Math.floor(targetTimestampMs / 1000) // Convert to seconds

  logger.debug('[EvmBlockSearch] Starting binary search for block by timestamp', {
    chainKey,
    targetTimestampMs,
    targetTimestamp,
  })

  try {
    // Get latest block
    const latestBlock = await retryWithBackoff(
      () => provider.getBlockNumber(),
      3,
      500,
      5000,
      abortSignal,
    )

    const latestBlockData = await retryWithBackoff(
      () => provider.getBlock('latest'),
      3,
      500,
      5000,
      abortSignal,
    )

    if (!latestBlockData) {
      throw new Error('Failed to fetch latest block')
    }

    logger.debug('[EvmBlockSearch] Latest block info', {
      chainKey,
      latestBlock,
      latestTimestamp: latestBlockData.timestamp,
      targetTimestamp,
    })

    // If target timestamp is after latest block, return latest block
    if (targetTimestamp >= latestBlockData.timestamp) {
      logger.debug('[EvmBlockSearch] Target timestamp is after latest block, returning latest', {
        chainKey,
        targetTimestamp,
        latestTimestamp: latestBlockData.timestamp,
        latestBlock,
      })
      return latestBlock
    }

    // Get genesis block
    const genesis = await getGenesisBlock(provider, chainKey, abortSignal)

    // If target timestamp is before genesis block, return genesis block
    if (targetTimestamp <= genesis.timestamp) {
      logger.debug('[EvmBlockSearch] Target timestamp is before genesis block, returning genesis', {
        chainKey,
        targetTimestamp,
        genesisTimestamp: genesis.timestamp,
        genesisBlock: genesis.number,
      })
      return genesis.number
    }

    // Binary search between genesis and latest
    let left = genesis.number
    let right = latestBlock
    let result = genesis.number

    logger.debug('[EvmBlockSearch] Starting binary search', {
      chainKey,
      left,
      right,
      targetTimestamp,
    })

    let iterations = 0
    const maxIterations = 50 // Safety limit (log2 of very large block range)

    while (left <= right && iterations < maxIterations) {
      if (isAborted(abortSignal)) {
        throw new Error('Block search cancelled')
      }

      iterations++
      const mid = Math.floor((left + right) / 2)

      logger.debug('[EvmBlockSearch] Binary search iteration', {
        chainKey,
        iteration: iterations,
        left,
        right,
        mid,
        targetTimestamp,
      })

      try {
        const midBlock = await retryWithBackoff(
          () => provider.getBlock(mid),
          3,
          500,
          5000,
          abortSignal,
        )

        if (!midBlock) {
          // Block not found, adjust range
          logger.debug('[EvmBlockSearch] Block not found, adjusting range', {
            chainKey,
            mid,
          })
          right = mid - 1
          continue
        }

        const midTimestamp = midBlock.timestamp

        logger.debug('[EvmBlockSearch] Block fetched', {
          chainKey,
          blockNumber: mid,
          timestamp: midTimestamp,
          targetTimestamp,
          diff: midTimestamp - targetTimestamp,
        })

        if (midTimestamp <= targetTimestamp) {
          // This block is before or at target, it's a candidate
          result = mid
          left = mid + 1 // Search for later blocks
        } else {
          // This block is after target, search earlier
          right = mid - 1
        }
      } catch (error) {
        logger.warn('[EvmBlockSearch] Failed to fetch block, adjusting range', {
          chainKey,
          mid,
          error: error instanceof Error ? error.message : String(error),
        })
        // If block fetch fails, try earlier blocks
        right = mid - 1
      }
    }

    if (iterations >= maxIterations) {
      logger.warn('[EvmBlockSearch] Binary search hit max iterations, using result', {
        chainKey,
        iterations,
        result,
      })
    }

    logger.info('[EvmBlockSearch] Binary search completed', {
      chainKey,
      targetTimestampMs,
      targetTimestamp,
      resultBlock: result,
      iterations,
    })

    return result
  } catch (error) {
    logger.error('[EvmBlockSearch] Binary search failed', {
      chainKey,
      targetTimestampMs,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

