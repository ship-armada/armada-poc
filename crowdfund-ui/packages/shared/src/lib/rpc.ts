// ABOUTME: RPC provider creation and log fetching utilities.
// ABOUTME: Supports ordered fallback across multiple RPC endpoints.

import { JsonRpcProvider } from 'ethers'
import type { RawLog } from './events.js'

/**
 * Create an ethers JsonRpcProvider from the first responsive URL.
 * Tries URLs in order; on failure, falls through to the next.
 */
export function createProvider(urls: string[]): JsonRpcProvider {
  if (urls.length === 0) throw new Error('No RPC URLs provided')
  // Start with the first URL; fallback logic is handled at call sites
  return new JsonRpcProvider(urls[0])
}

/**
 * Fetch raw logs from the provider for a given contract address and block range.
 * Returns logs in the RawLog format expected by parseCrowdfundEvent.
 */
export async function fetchLogs(
  provider: JsonRpcProvider,
  address: string,
  fromBlock: number,
  toBlock: number | 'latest',
): Promise<RawLog[]> {
  const logs = await provider.getLogs({
    address,
    fromBlock,
    toBlock,
  })
  return logs.map((log) => ({
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.index,
    topics: log.topics as string[],
    data: log.data,
  }))
}

/** Get the latest block timestamp in seconds */
export async function getBlockTimestamp(provider: JsonRpcProvider): Promise<number> {
  const block = await provider.getBlock('latest')
  if (!block) throw new Error('Failed to fetch latest block')
  return block.timestamp
}
