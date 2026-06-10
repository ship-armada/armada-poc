// ABOUTME: Throttled writer for proof-generation progress — atom-only, no IDB. 10% buckets per write to avoid hammering the OCC sequence on every SDK callback.
// ABOUTME: Returns a writer that ALSO exposes the live record — the handler MUST use `latest()` when constructing the next stage's transition; using the original record param hits the OCC guard and the transition is silently dropped.

import { getDefaultStore } from 'jotai'
import { upsertTxAtom } from '@/state/tx'
import type { TxKind, TxRecord } from './types'

export interface ProofProgressWriter<K extends TxKind> {
  /** Pass to the SDK as `onProgress`. Throttled to ~10% buckets. */
  write(fraction: number): void
  /**
   * Returns the most recently written record. The handler MUST pass this (not the original
   * `record` parameter) to `advance(...)` when transitioning out of build-proof, because
   * every progress write bumped `updatedSeq` — the original record's seq is now stale and
   * `upsertTxAtom`'s OCC guard would drop the transition.
   */
  latest(): TxRecord<K>
}

/**
 * Build a throttled progress writer for a single proof-generation pass. The writer tracks the
 * latest record across writes — each write bumps `updatedSeq` so OCC accepts it.
 *
 *   const progress = createProofProgressWriter(record)
 *   await generateXxxProof({ ..., onProgress: progress.write })
 *   await ctx.upsert(advance(progress.latest(), 'submit-relayer'))
 *
 * Bucket size = 10% so we write ~10 times per proof gen, not the hundreds of intermediate
 * callbacks the SDK can fire. The first bucket (0.1) lands quickly and gives the user
 * "something is happening" feedback within the first second or two.
 *
 * Pass the handler's `ctx.signal` so the writer no-ops once the tx is cancelled mid-proof. The
 * SDK can fire `onProgress` callbacks after `cancelTx` has already written the terminal record;
 * without this guard those late writes carry the writer's own (higher) `updatedSeq` and an
 * `active`/`build-proof` body, which would flip the cancelled record back to in-flight. The
 * terminal-write guard in upsertTxAtom is the belt; this is the braces. (P0-3 WS1.2b)
 */
export function createProofProgressWriter<K extends TxKind>(
  initial: TxRecord<K>,
  signal?: AbortSignal,
): ProofProgressWriter<K> {
  const store = getDefaultStore()
  let liveRecord: TxRecord<K> = initial
  let lastBucket = -1
  return {
    write(fraction: number) {
      if (signal?.aborted) return
      const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
      const bucket = Math.floor(clamped * 10)
      if (bucket === lastBucket) return
      lastBucket = bucket
      liveRecord = {
        ...liveRecord,
        artifacts: { ...liveRecord.artifacts, proofProgress: bucket / 10 },
        updatedSeq: liveRecord.updatedSeq + 1,
        updatedAt: Date.now(),
      }
      // Atom-only write — progress is ephemeral. `upsertTxAtom`'s OCC guard relies on the
      // bumped `updatedSeq`, which we did above.
      store.set(upsertTxAtom, liveRecord as TxRecord)
    },
    latest() {
      return liveRecord
    },
  }
}
