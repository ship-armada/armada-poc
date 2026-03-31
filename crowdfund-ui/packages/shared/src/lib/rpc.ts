// ABOUTME: RPC provider creation and log fetching utilities.
// ABOUTME: Supports ordered fallback across multiple RPC endpoints.

import { JsonRpcProvider } from 'ethers'
import type { JsonRpcPayload, JsonRpcResult } from 'ethers'
import type { RawLog } from './events.js'

/**
 * JsonRpcProvider subclass that tries multiple RPC URLs in order.
 * On transport-level errors (connection refused, timeout, HTTP 5xx),
 * automatically retries with the next URL in the list.
 * RPC-level errors (execution reverted, invalid params) are NOT retried.
 *
 * Note: overrides ethers v6 internal _send() method. If ethers changes
 * its internal transport API, this class will need updating.
 */
export class FallbackJsonRpcProvider extends JsonRpcProvider {
  /** @internal Exposed for testing — the internal providers for each URL */
  readonly _providers: JsonRpcProvider[]
  private _currentIndex: number = 0

  constructor(urls: string[]) {
    super(urls[0])
    this._providers = urls.map((url) => new JsonRpcProvider(url))
  }

  async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<(JsonRpcResult)[]> {
    let lastError: unknown

    for (let attempt = 0; attempt < this._providers.length; attempt++) {
      const index = (this._currentIndex + attempt) % this._providers.length

      try {
        const result = await this._providers[index]._send(payload)
        // Success — rotate to this provider for future calls
        this._currentIndex = index
        return result
      } catch (err) {
        lastError = err
        // Continue to next provider on transport errors
      }
    }

    throw lastError
  }
}

/**
 * Create an ethers JsonRpcProvider with ordered fallback.
 * Single URL: returns plain JsonRpcProvider.
 * Multiple URLs: returns FallbackJsonRpcProvider that retries on transport failure.
 */
export function createProvider(urls: string[]): JsonRpcProvider {
  if (urls.length === 0) throw new Error('No RPC URLs provided')
  if (urls.length === 1) return new JsonRpcProvider(urls[0])
  return new FallbackJsonRpcProvider(urls)
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
