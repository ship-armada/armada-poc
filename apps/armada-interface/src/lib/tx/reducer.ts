// ABOUTME: Pure state transitions for TxRecord — advance(), markFailed(), markExpired(), markCancelled(), etc. No React, no IO.
// ABOUTME: Hooks call these and write the result back to the txListAtom + IDB. Every transition increments updatedSeq (OCC; see storage.ts).

import { lifecycleFor } from './lifecycles'
import type { ArtifactsFor, StageFor, TxError, TxKind, TxRecord } from './types'

/** Reach the next stage. Sets executionState to `completed` if at terminalSuccess, else `active`. */
export function advance<K extends TxKind>(
  record: TxRecord<K>,
  toStage: StageFor<K>,
  artifactPatch: Partial<ArtifactsFor<K>> = {},
): TxRecord<K> {
  const lifecycle = lifecycleFor(record.kind)
  const stages = lifecycle.stages
  const toIndex = stages.indexOf(toStage)
  if (toIndex === -1) {
    throw new Error(`reducer.advance: stage "${toStage}" is not part of lifecycle "${record.kind}"`)
  }

  const newCompleted = [...new Set([...record.stagesCompleted, ...stages.slice(0, toIndex)])] as StageFor<K>[]
  const isTerminal = toStage === lifecycle.terminalSuccess

  return {
    ...record,
    stage: toStage,
    stagesCompleted: newCompleted,
    executionState: isTerminal ? 'completed' : 'active',
    updatedSeq: record.updatedSeq + 1,
    updatedAt: Date.now(),
    artifacts: { ...record.artifacts, ...artifactPatch },
  }
}

/** Stage is in flight but blocked on an external event (e.g. Iris attestation). */
export function markWaiting<K extends TxKind>(record: TxRecord<K>): TxRecord<K> {
  return {
    ...record,
    executionState: 'waiting',
    updatedSeq: record.updatedSeq + 1,
    updatedAt: Date.now(),
  }
}

/** A retry attempt is in flight after a recoverable failure. */
export function markRetrying<K extends TxKind>(record: TxRecord<K>): TxRecord<K> {
  return {
    ...record,
    executionState: 'retrying',
    updatedSeq: record.updatedSeq + 1,
    updatedAt: Date.now(),
  }
}

/**
 * Mark a record `failed`. Accepts either a typed TxError or a plain string (auto-wrapped as
 * `{ code: 'OTHER', message: string }`) so existing call sites that didn't categorize compile
 * without change — new code should pass typed errors so the UI can pick honest copy.
 */
export function markFailed<K extends TxKind>(
  record: TxRecord<K>,
  error: TxError | string,
): TxRecord<K> {
  const errorObj: TxError = typeof error === 'string' ? { code: 'OTHER', message: error } : error
  return {
    ...record,
    executionState: 'failed',
    updatedSeq: record.updatedSeq + 1,
    updatedAt: Date.now(),
    artifacts: { ...record.artifacts, error: errorObj } as Partial<ArtifactsFor<K>>,
  }
}

export function markExpired<K extends TxKind>(record: TxRecord<K>): TxRecord<K> {
  return {
    ...record,
    executionState: 'expired',
    updatedSeq: record.updatedSeq + 1,
    updatedAt: Date.now(),
  }
}

/**
 * User-initiated cancel of a pre-broadcast record. Sets a CANCELLED error so the UI can render
 * honest copy ("Cancelled — no transaction was sent") and distinguish from auto-lock cleanup or
 * other internal cancels.
 *
 * For post-broadcast records, use `markDismissed` instead — the on-chain tx still runs but we
 * stopped watching it.
 */
export function markCancelled<K extends TxKind>(record: TxRecord<K>): TxRecord<K> {
  const cancelError: TxError = { code: 'CANCELLED', message: 'Cancelled before submission.' }
  return {
    ...record,
    executionState: 'cancelled',
    updatedSeq: record.updatedSeq + 1,
    updatedAt: Date.now(),
    artifacts: { ...record.artifacts, error: cancelError } as Partial<ArtifactsFor<K>>,
  }
}

/**
 * User "stopped tracking" a record that had already broadcast on chain. The tx will still run to
 * completion (or revert) on chain — we just dropped it from our active polling. Persists the
 * sourceTxHash in the error so the UI can link the user to the explorer.
 */
export function markDismissed<K extends TxKind>(record: TxRecord<K>): TxRecord<K> {
  const sourceTxHash = (record.artifacts as { sourceTxHash?: `0x${string}` }).sourceTxHash
  const dismissError: TxError = {
    code: 'DISMISSED',
    message: 'Stopped tracking — the transaction may still complete on chain.',
    txHash: sourceTxHash,
  }
  return {
    ...record,
    executionState: 'cancelled',
    updatedSeq: record.updatedSeq + 1,
    updatedAt: Date.now(),
    artifacts: { ...record.artifacts, error: dismissError } as Partial<ArtifactsFor<K>>,
  }
}

/**
 * Reconcile a non-terminal-but-confirmed record discovered by history recovery: the chain shows
 * the tx landed, but our local record terminated as `expired`/`failed`/`cancelled` (or is still
 * mid-flight) because we lost the watcher. Upgrade it IN PLACE to `completed` — advance to the
 * lifecycle's terminal-success stage, drop the stale error, keep `sourceTxHash` + the rest of the
 * artifacts — rather than skipping (a permanent false "expired") or inserting a lossy `synth:` row
 * beside it. (P1-24)
 *
 * The terminal-write guard allows this because it's terminal→`completed` (terminal→terminal). The
 * caller MUST build this from the LATEST stored record so the bumped `updatedSeq` clears OCC.
 */
export function markRecoveredComplete<K extends TxKind>(record: TxRecord<K>): TxRecord<K> {
  const lifecycle = lifecycleFor(record.kind)
  const terminal = lifecycle.terminalSuccess
  const stages = lifecycle.stages
  const toIndex = stages.indexOf(terminal)
  const newCompleted = [
    ...new Set([...record.stagesCompleted, ...stages.slice(0, toIndex), terminal]),
  ] as StageFor<K>[]
  const nextArtifacts = { ...record.artifacts }
  delete (nextArtifacts as { error?: unknown }).error
  return {
    ...record,
    stage: terminal,
    stagesCompleted: newCompleted,
    executionState: 'completed',
    updatedSeq: record.updatedSeq + 1,
    updatedAt: Date.now(),
    artifacts: nextArtifacts,
  }
}

/**
 * Merge artifacts without touching stage or executionState. Used by polling handlers that need
 * to persist progress (e.g. advancing a log-scan cursor between ticks) while the record stays in
 * `waiting`. Increments updatedSeq so OCC writes succeed in order.
 */
export function patchArtifacts<K extends TxKind>(
  record: TxRecord<K>,
  artifactPatch: Partial<ArtifactsFor<K>>,
): TxRecord<K> {
  return {
    ...record,
    updatedSeq: record.updatedSeq + 1,
    updatedAt: Date.now(),
    artifacts: { ...record.artifacts, ...artifactPatch },
  }
}

/** Is the current stage one the user/executor can retry from (vs starting over)? */
export function isRetryable<K extends TxKind>(record: TxRecord<K>): boolean {
  const lifecycle = lifecycleFor(record.kind)
  return (lifecycle.retryableStages as readonly string[]).includes(record.stage)
}

/**
 * Should this record be polled on app resume? Plan §7 + reviewer #7:
 *   non-terminal AND (Date.now() - createdAt) < lifecycle.maxDurationMs → resume
 *   else → caller marks it expired
 *
 * Using createdAt rather than updatedAt because the lifecycle cap is wall-clock total,
 * not idle time. A long pause in updates while waiting on Iris is normal.
 */
export function shouldResume<K extends TxKind>(record: TxRecord<K>): boolean {
  if (
    record.executionState === 'completed' ||
    record.executionState === 'failed' ||
    record.executionState === 'expired' ||
    record.executionState === 'cancelled'
  ) {
    return false
  }
  const lifecycle = lifecycleFor(record.kind)
  return Date.now() - record.createdAt < lifecycle.maxDurationMs
}
