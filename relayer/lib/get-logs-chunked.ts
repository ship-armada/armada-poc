/**
 * ABOUTME: Cursor-checkpointed scan helper. Splits a block range into chunks so the per-chunk
 * `onChunk` callback can ingest + persist mid-flight — a failure mid-window loses at most one
 * chunk of replay, not the whole window. Per-RPC-call range caps (Alchemy free 10 blocks,
 * Infura 10k, drpc varies) are handled separately by `rpc-bisecting.ts` which intercepts
 * eth_getLogs and recursively halves on the relevant error patterns.
 * ABOUTME: Adapted from apps/armada-interface/src/lib/events/getLogsChunked.ts — the chunking +
 * `collect` behaviour are kept in lockstep; `perCallTimeoutMs` is relayer-only (the frontend uses
 * an AbortSignal for the same purpose). Update both files in the same PR or extract to a shared
 * package per Plan §19 when a third consumer appears.
 */

import type { ethers } from "ethers";
import { withTimeout } from "./rpc-utils";

/**
 * Per-chunk progress signal. Fired after each successful chunk so callers can persist the
 * cursor + ingest the chunk's logs mid-flight — if the next chunk fails, the cursor reflects
 * what HAS been processed rather than what was attempted. The `logs` array carries the chunk's
 * logs so the caller can ingest synchronously alongside the cursor advance, keeping the two
 * actions in lockstep (avoids "cursor advanced past logs we never enqueued" scenarios on
 * mid-window error).
 */
export interface ChunkProgress<TLog = unknown> {
  fromBlock: number;
  toBlockInclusive: number;
  logs: TLog[];
}

export interface ChunkedLogsOptions {
  /** Inclusive lower block. */
  fromBlock: number;
  /** Inclusive upper block. */
  toBlock: number;
  /** Inclusive max blocks per chunk. Must be ≥ 1. */
  maxRange: number;
  /** ethers Filter — address + topics + (the function adds fromBlock/toBlock per chunk). */
  filter: Omit<ethers.Filter, "fromBlock" | "toBlock">;
  /**
   * Fires after each successful chunk so the caller can ingest the chunk's logs + persist the
   * cursor advance in lockstep. The callback may be async; the helper awaits it before issuing
   * the next chunk — this is critical for crash safety, since "persisted cursor must always
   * trail or equal ingested logs."
   */
  onChunk?: (info: ChunkProgress<ethers.Log>) => Promise<void> | void;
  /**
   * Optional per-`getLogs`-call timeout (ms). When set, each chunk's getLogs is raced against this
   * budget so one wedged RPC socket can't pin the poll loop (and the module's stop()). On timeout
   * the call throws, halting the scan with the cursor at the last completed chunk — same recovery
   * as any other getLogs error. Relayer-only addition (the long-running scanner needs it); the
   * frontend twin leaves it unset.
   */
  perCallTimeoutMs?: number;
  /**
   * Accumulate every chunk's logs into the returned array. Default true for backward-compat.
   * Callers that ingest exclusively via `onChunk` (both relay scanners) pass `false` so a large
   * backfill doesn't hold a second copy of every log in memory for the scan's duration.
   */
  collect?: boolean;
}

/**
 * Fetch logs across an arbitrarily large block range by issuing a sequence of bounded `getLogs`
 * calls, each spanning at most `maxRange` blocks inclusive. Results are concatenated in
 * chunk-issued order (ascending blocks).
 *
 * On error mid-iteration: throws. The caller has received all `onChunk` callbacks for chunks
 * that completed successfully — so persisting the cursor inside `onChunk` lets the next poll
 * tick resume from `lastSuccessfulChunk.toBlockInclusive + 1` rather than re-scanning everything.
 *
 * This is the failure mode that bit us in the un-chunked design: an RPC outage halfway through
 * a 10k-block range meant the next attempt tried 10k+ blocks (worse), failed again (silent),
 * and so on forever. Chunked + per-chunk persistence means a transient outage costs at most
 * `maxRange` blocks of replay on the next tick.
 */
export async function getLogsChunked(
  provider: ethers.JsonRpcProvider,
  opts: ChunkedLogsOptions,
): Promise<ethers.Log[]> {
  if (opts.maxRange < 1) {
    throw new Error(`getLogsChunked: maxRange must be ≥ 1 (got ${opts.maxRange})`);
  }
  if (opts.fromBlock > opts.toBlock) return [];

  const collect = opts.collect ?? true;
  const out: ethers.Log[] = [];
  let cursor = opts.fromBlock;

  while (cursor <= opts.toBlock) {
    // Inclusive window: [cursor, cursor + maxRange - 1], clamped at toBlock.
    const windowEnd = cursor + opts.maxRange - 1;
    const chunkTo = windowEnd > opts.toBlock ? opts.toBlock : windowEnd;

    const getLogsCall = provider.getLogs({
      ...opts.filter,
      fromBlock: cursor,
      toBlock: chunkTo,
    });
    const logs = opts.perCallTimeoutMs
      ? await withTimeout(getLogsCall, opts.perCallTimeoutMs, `getLogs ${cursor}-${chunkTo}`)
      : await getLogsCall;

    if (collect) out.push(...logs);
    // Awaited so the caller's ingest + persist completes BEFORE we move on to the next chunk.
    // This is the contract that makes per-chunk progress crash-safe: the cursor is never
    // advanced past logs the caller hasn't accepted responsibility for.
    if (opts.onChunk) {
      await opts.onChunk({
        fromBlock: cursor,
        toBlockInclusive: chunkTo,
        logs,
      });
    }

    cursor = chunkTo + 1;
  }

  return out;
}
