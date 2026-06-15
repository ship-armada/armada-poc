// ABOUTME: Bounded-window getLogs helper. Splits a block range into max-size chunks so a single query never exceeds public RPC caps.
// ABOUTME: Generic over the log shape and over the per-chunk query payload (event/topics/args) so it adapts to both viem and ethers callers.

/**
 * Minimal client surface this helper depends on. Concrete implementations supply a
 * `getLogs({ fromBlock, toBlock, ...query })` taking inclusive bigint block bounds and an optional
 * abort signal, plus a `getBlockNumber()` for resolving `toBlock: 'latest'`. Both viem's
 * `PublicClient` and an ethers wrapper conform after minor adaptation at the call site.
 */
export interface ChunkedLogsClient<TLog> {
  getBlockNumber(): Promise<bigint>
  getLogs(args: { fromBlock: bigint; toBlock: bigint; [extra: string]: unknown }): Promise<TLog[]>
}

export interface ChunkedLogsOptions<TQuery extends Record<string, unknown>> {
  fromBlock: bigint
  toBlock: bigint | 'latest'
  /** Inclusive max blocks per chunk. Must be ≥ 1. Pulled from `NetworkConfig.maxLogRange`. */
  maxRange: number
  /** Per-chunk query payload (address, event, topics, args, ...) — merged into each getLogs call. */
  query: () => TQuery
  signal?: AbortSignal
  /**
   * Optional progress hook fired after each completed chunk. The `toBlockInclusive` is the highest
   * block scanned so far — callers can persist this between ticks so a resume doesn't re-scan.
   */
  onChunk?: (info: { fromBlock: bigint; toBlockInclusive: bigint; logsInChunk: number }) => void
  /**
   * Accumulate every chunk's logs into the returned array. Default true. Callers that consume only
   * via `onChunk` pass false to avoid holding a second copy of every log for the scan's duration.
   */
  collect?: boolean
}

/**
 * Fetch logs across an arbitrarily large block range by issuing a sequence of bounded `getLogs`
 * calls, each spanning at most `maxRange` blocks inclusive. Results are concatenated in
 * chunk-issued order (ascending blocks). Aborts cleanly between chunks if the signal trips; an
 * in-flight underlying call must itself honor the signal for mid-chunk cancellation.
 */
export async function getLogsChunked<TLog, TQuery extends Record<string, unknown> = Record<string, never>>(
  client: ChunkedLogsClient<TLog>,
  opts: ChunkedLogsOptions<TQuery>,
): Promise<TLog[]> {
  if (opts.maxRange < 1) {
    throw new Error(`getLogsChunked: maxRange must be ≥ 1 (got ${opts.maxRange})`)
  }

  const toBlock = opts.toBlock === 'latest' ? await client.getBlockNumber() : opts.toBlock

  if (opts.fromBlock > toBlock) return []

  const collect = opts.collect ?? true
  const out: TLog[] = []
  const stride = BigInt(opts.maxRange)
  let cursor = opts.fromBlock

  while (cursor <= toBlock) {
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    // Inclusive window: [cursor, cursor + stride - 1], clamped at toBlock.
    const windowEnd = cursor + stride - 1n
    const chunkTo = windowEnd > toBlock ? toBlock : windowEnd
    const logs = await client.getLogs({
      ...opts.query(),
      fromBlock: cursor,
      toBlock: chunkTo,
    })
    if (collect) out.push(...logs)
    opts.onChunk?.({ fromBlock: cursor, toBlockInclusive: chunkTo, logsInChunk: logs.length })
    cursor = chunkTo + 1n
  }

  return out
}
