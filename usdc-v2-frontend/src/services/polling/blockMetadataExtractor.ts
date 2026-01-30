/**
 * Block Metadata Extractor
 * 
 * Helper utilities to extract block height, block timestamp, and transaction hash
 * from EVM and Tendermint chains when events are matched during polling.
 * 
 * These functions handle RPC calls with retry logic and return partial metadata
 * if some fields are unavailable, ensuring polling continues even if extraction fails.
 */

import { ethers } from 'ethers'
import { logger } from '@/utils/logger'
import { retryWithBackoff, isAborted } from './basePoller'
import type { TendermintRpcClient } from './tendermintRpcClient'

/**
 * Block metadata extracted from chain
 */
export interface BlockMetadata {
  /** Block height/number */
  blockHeight?: number | string
  /** Block timestamp (Unix timestamp in seconds) */
  blockTimestamp?: number
  /** Transaction hash where the event occurred */
  eventTxHash?: string
}

/**
 * Extract block metadata from EVM chain
 * 
 * @param provider - EVM provider
 * @param blockNumber - Block number (can be bigint or number)
 * @param txHash - Transaction hash
 * @param abortSignal - Optional abort signal
 * @returns Block metadata (partial if extraction fails)
 */
export async function extractEvmBlockMetadata(
  provider: ethers.JsonRpcProvider,
  blockNumber: number | bigint,
  txHash: string,
  abortSignal?: AbortSignal,
): Promise<BlockMetadata> {
  const metadata: BlockMetadata = {
    eventTxHash: txHash,
  }

  try {
    // Check abort signal before making RPC call
    if (isAborted(abortSignal)) {
      logger.debug('[BlockMetadataExtractor] Abort signal detected, skipping EVM block metadata extraction')
      return metadata
    }

    // Convert blockNumber to number if it's a bigint
    const blockNum = typeof blockNumber === 'bigint' ? Number(blockNumber) : blockNumber

    // Fetch block to get timestamp
    const block = await retryWithBackoff(
      () => provider.getBlock(blockNum),
      3,
      500,
      5000,
      abortSignal,
    )

    if (block) {
      metadata.blockHeight = block.number
      // Convert timestamp from seconds to number (it's already a number in ethers)
      metadata.blockTimestamp = block.timestamp
      
      logger.debug('[BlockMetadataExtractor] EVM block metadata extracted', {
        blockHeight: metadata.blockHeight,
        blockTimestamp: metadata.blockTimestamp,
        txHash: metadata.eventTxHash,
      })
    } else {
      logger.warn('[BlockMetadataExtractor] Block not found for EVM', {
        blockNumber: blockNum,
        txHash,
      })
    }
  } catch (error) {
    // Log warning but don't fail - return partial metadata
    logger.warn('[BlockMetadataExtractor] Failed to extract EVM block metadata', {
      blockNumber: typeof blockNumber === 'bigint' ? blockNumber.toString() : blockNumber,
      txHash,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return metadata
}

/**
 * Extract block metadata from Tendermint chain
 * 
 * Note: getBlockResults only contains height, not timestamp.
 * This function fetches the block separately using getBlock to get the timestamp.
 * 
 * @param rpcClient - Tendermint RPC client
 * @param blockHeight - Block height
 * @param txHash - Transaction hash
 * @param abortSignal - Optional abort signal
 * @returns Block metadata (partial if extraction fails)
 */
export async function extractTendermintBlockMetadata(
  rpcClient: TendermintRpcClient,
  blockHeight: number,
  txHash: string,
  abortSignal?: AbortSignal,
): Promise<BlockMetadata> {
  const metadata: BlockMetadata = {
    blockHeight,
    eventTxHash: txHash,
  }

  try {
    // Check abort signal before making RPC call
    if (isAborted(abortSignal)) {
      logger.debug('[BlockMetadataExtractor] Abort signal detected, skipping Tendermint block metadata extraction')
      return metadata
    }

    // Fetch block to get timestamp (getBlockResults only has height)
    const block = await retryWithBackoff(
      () => rpcClient.getBlock(blockHeight, abortSignal),
      3,
      500,
      5000,
      abortSignal,
    )

    if (block) {
      // Extract timestamp from block
      // Tendermint blocks have timestamp in block.header.time or block.block.header.time
      const timestampStr = block.block?.header?.time || block.header?.time
      if (timestampStr) {
        // Parse ISO 8601 timestamp to Unix timestamp (seconds)
        const timestampDate = new Date(timestampStr)
        if (!isNaN(timestampDate.getTime())) {
          metadata.blockTimestamp = Math.floor(timestampDate.getTime() / 1000)
          
          logger.debug('[BlockMetadataExtractor] Tendermint block metadata extracted', {
            blockHeight: metadata.blockHeight,
            blockTimestamp: metadata.blockTimestamp,
            txHash: metadata.eventTxHash,
          })
        } else {
          logger.warn('[BlockMetadataExtractor] Invalid timestamp format in Tendermint block', {
            blockHeight,
            timestampStr,
            txHash,
          })
        }
      } else {
        logger.warn('[BlockMetadataExtractor] Timestamp not found in Tendermint block', {
          blockHeight,
          txHash,
          blockKeys: Object.keys(block),
        })
      }
    } else {
      logger.warn('[BlockMetadataExtractor] Block not found for Tendermint', {
        blockHeight,
        txHash,
      })
    }
  } catch (error) {
    // Log warning but don't fail - return partial metadata
    logger.warn('[BlockMetadataExtractor] Failed to extract Tendermint block metadata', {
      blockHeight,
      txHash,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return metadata
}

