// ABOUTME: Pure per-tick scan helper used by the xchain unshield handler — caps the eth_getLogs window to maxLogRange blocks and advances a cursor between ticks.
// ABOUTME: Lifted out of handler.ts so the cursor/window math is unit-testable without dragging in wagmi, ethers, or the SDK.

/**
 * Minimal log shape we need: a (possibly absent) transaction hash for the match outcome. Typed
 * as plain `string` so both viem (`\`0x${string}\``) and ethers (`string`) Log shapes
 * structurally satisfy it. The outcome's `txHash` re-narrows to the hex brand at the boundary
 * since on-chain logs always carry hex-string tx hashes.
 */
export type ScanLog = { transactionHash?: string | null }

/** Caller-supplied range query. Lets the handler keep viem's typed event filter without leaking it into this helper's signature. */
export type GetLogsForRange<TLog extends ScanLog = ScanLog> = (
  fromBlock: bigint,
  toBlock: bigint,
) => Promise<ReadonlyArray<TLog>>

export interface ScanInput<TLog extends ScanLog = ScanLog> {
  getBlockNumber: () => Promise<bigint>
  getLogsForRange: GetLogsForRange<TLog>
  /** Current low watermark — the cursor advances forward from here. */
  scanFromBlock: bigint
  /** Cap on blocks scanned per tick. From `NetworkConfig.maxLogRange`. */
  maxLogRange: bigint
  /**
   * Filter logs down to "ours". When omitted, the first log in the window matches (legacy
   * behaviour). For CCTP V2 destination scans this MUST be supplied — the indexed nonce topic
   * is an Iris-assigned `eventNonce` that isn't derivable from the source side, so the handler
   * has to drop the topic filter and match on the message body's hookData instead.
   */
  matchPredicate?: (log: TLog) => boolean
}

export type ScanOutcome =
  | { kind: 'match'; txHash: `0x${string}` }
  /** No new blocks since the cursor — caller should sleep and retry. */
  | { kind: 'no-new-blocks' }
  /** Scanned a window but found nothing; cursor advanced. Caller persists `nextScanFromBlock`. */
  | { kind: 'no-match'; nextScanFromBlock: bigint; scannedTo: bigint }

/**
 * One tick of the cross-chain delivery scan.
 *
 *  - Resolves the chain's latest block.
 *  - Computes a bounded inclusive window `[scanFromBlock, min(scanFromBlock + maxLogRange - 1, latest)]`.
 *  - Issues a single getLogs call against that window via the caller-supplied query.
 *  - Returns a typed outcome: match found, no new blocks, or scanned-but-empty.
 *
 * The caller (handler) is responsible for persisting `nextScanFromBlock` on `no-match` so a crash
 * + resume doesn't re-scan history.
 */
export async function scanCctpDeliveryWindow<TLog extends ScanLog>(
  input: ScanInput<TLog>,
): Promise<ScanOutcome> {
  if (input.maxLogRange < 1n) {
    throw new Error(`scanCctpDeliveryWindow: maxLogRange must be ≥ 1 (got ${input.maxLogRange})`)
  }

  const latest = await input.getBlockNumber()
  if (input.scanFromBlock > latest) {
    return { kind: 'no-new-blocks' }
  }

  const windowEnd = input.scanFromBlock + input.maxLogRange - 1n
  const toBlock = windowEnd > latest ? latest : windowEnd

  const logs = await input.getLogsForRange(input.scanFromBlock, toBlock)

  const matched = input.matchPredicate ? logs.find(input.matchPredicate) : logs[0]
  if (matched?.transactionHash) {
    // Re-narrow to the hex-string brand. On-chain logs always carry a 0x-prefixed hex tx hash;
    // the type widening on ScanLog is purely to bridge viem's branded literal and ethers' plain
    // `string`. The cast restores the brand for callers.
    return { kind: 'match', txHash: matched.transactionHash as `0x${string}` }
  }

  return { kind: 'no-match', nextScanFromBlock: toBlock + 1n, scannedTo: toBlock }
}

/**
 * Does a destination CCTP `MessageReceived` event match THIS unshield-xchain record's delivery? (T-M7)
 *
 * The V2 destination CCTP `nonce` is Iris-assigned and unpredictable source-side, so we identify our
 * delivery by content: a per-transaction `uniqueNonce` marker in the hookData (issue #287) — distinct
 * even between two same-recipient unshields. We also require the event's CCTP `sourceDomain` to be the
 * hub's domain, so an unrelated CCTP transfer from a DIFFERENT source chain can't false-complete the
 * record with the wrong destTxHash.
 */
export function matchesXchainDelivery(
  args: { messageBody?: unknown; sourceDomain?: unknown },
  expected: { marker: string; sourceDomain: number },
): boolean {
  if (Number(args.sourceDomain) !== expected.sourceDomain) return false
  const body = args.messageBody
  return typeof body === 'string' && body.toLowerCase().includes(expected.marker)
}
