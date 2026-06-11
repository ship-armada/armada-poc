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

/** Default max block range per eth_getLogs request. Free-tier RPCs (e.g. Alchemy)
 *  can be as low as 10 blocks. Paid tiers typically support 10k–100k+. */
const DEFAULT_MAX_BLOCK_RANGE = 10

/** Delay between chunked requests to avoid RPC rate limits (ms). */
const CHUNK_DELAY_MS = 100

function toRawLog(log: { blockNumber: number; transactionHash: string; index: number; topics: readonly string[]; data: string }): RawLog {
  return {
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.index,
    topics: log.topics as string[],
    data: log.data,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface FetchLogsResult {
  logs: RawLog[]
  /** The block number `toBlock` resolved to — the upper bound actually scanned.
   *  Callers should use this as their next cursor, not a separate getBlockNumber()
   *  call (which can drift past the range this fetch covered). */
  resolvedTo: number
}

export interface FetchLogsChunk {
  /** Raw logs for this chunk only. */
  logs: RawLog[]
  /** The first block of the whole scan (the original fromBlock). */
  fromBlock: number
  /** The resolved upper bound of the whole scan. */
  toBlock: number
  /** The block this chunk scanned up to — a safe cursor for resuming. */
  scannedTo: number
}

export interface FetchLogsOptions {
  /** Max blocks per eth_getLogs request. */
  maxBlockRange?: number
  /** Called after each chunk completes. Lets callers persist partial progress
   *  (events + cursor) so an interrupted backfill resumes instead of restarting,
   *  and drive a coarse sync-progress UI. */
  onChunk?: (chunk: FetchLogsChunk) => void
}

/** Heuristic: does this RPC error mean the requested block range was too large?
 *  Such errors are retryable with a smaller range (halve-and-retry). Distinct
 *  from rate limiting, which is handled by the provider's backoff. */
function isBlockRangeError(err: unknown): boolean {
  const message = (
    (err as { message?: string })?.message ??
    (err as { error?: { message?: string } })?.error?.message ??
    ''
  ).toLowerCase()
  return (
    /range/.test(message) ||
    /more than \d+ results/.test(message) ||
    /too many results/.test(message) ||
    /too large/.test(message) ||
    /response size/.test(message) ||
    /result set/.test(message) ||
    /exceed/.test(message)
  )
}

/**
 * Fetch raw logs from the provider for a given contract address and block range.
 * Chunks large ranges into maxBlockRange-sized requests with a small delay
 * between chunks. On a "block range too large" RPC error, halves the chunk size
 * and retries the same range. Calls `onChunk` after each successful chunk so the
 * caller can persist partial progress and show sync status.
 *
 * Returns logs in the RawLog format expected by parseCrowdfundEvent, plus the
 * resolved upper bound of the scan so the caller can advance its cursor exactly.
 */
export async function fetchLogs(
  provider: JsonRpcProvider,
  address: string,
  fromBlock: number,
  toBlock: number | 'latest',
  options: FetchLogsOptions = {},
): Promise<FetchLogsResult> {
  const { maxBlockRange = DEFAULT_MAX_BLOCK_RANGE, onChunk } = options
  const resolvedTo = toBlock === 'latest' ? await provider.getBlockNumber() : toBlock
  if (fromBlock > resolvedTo) return { logs: [], resolvedTo }

  const allLogs: RawLog[] = []
  let cursor = fromBlock
  let range = Math.max(1, maxBlockRange)
  let isFirstChunk = true

  while (cursor <= resolvedTo) {
    if (!isFirstChunk) await sleep(CHUNK_DELAY_MS)
    isFirstChunk = false

    const chunkEnd = Math.min(cursor + range - 1, resolvedTo)
    let logs
    try {
      logs = await provider.getLogs({ address, fromBlock: cursor, toBlock: chunkEnd })
    } catch (err) {
      if (isBlockRangeError(err) && range > 1) {
        // Range too large for this endpoint — shrink and retry the same cursor.
        range = Math.max(1, Math.floor(range / 2))
        continue
      }
      throw err
    }

    const chunk = logs.map(toRawLog)
    for (const log of chunk) allLogs.push(log)
    onChunk?.({ logs: chunk, fromBlock, toBlock: resolvedTo, scannedTo: chunkEnd })
    cursor = chunkEnd + 1
  }

  return { logs: allLogs, resolvedTo }
}

/** Get the latest block timestamp in seconds */
export async function getBlockTimestamp(provider: JsonRpcProvider): Promise<number> {
  const block = await provider.getBlock('latest')
  if (!block) throw new Error('Failed to fetch latest block')
  return block.timestamp
}
