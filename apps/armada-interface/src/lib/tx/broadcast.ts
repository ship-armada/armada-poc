// ABOUTME: Shared helper to persist a freshly-broadcast source tx hash without losing it to a concurrent cancel.
// ABOUTME: Re-reads the latest record (fresh OCC seq) and folds the hash into a dismissed record when the tx broadcast after a cancel.

import { getDefaultStore } from 'jotai'
import { txListAtom } from '@/state/tx'
import type { ExecutorCtx } from './executor'
import { markDismissed, patchArtifacts } from './reducer'
import { isTerminalState } from './types'
import type { ArtifactsFor, TxKind, TxRecord } from './types'

export interface BroadcastResult<K extends TxKind> {
  /** The record after the hash write — continue advancing from this (its seq is fresh). */
  record: TxRecord<K>
  /**
   * True when the tx broadcast after a cancel: the hash was folded into a `markDismissed` terminal
   * record. The caller MUST stop advancing (return from the stage) — the lifecycle is over.
   */
  dismissed: boolean
}

/**
 * Persist a source tx hash obtained from an on-chain broadcast (writeContract / sendTransaction /
 * relayer submit). Re-reads the LATEST record by id so the write carries a fresh `updatedSeq` and
 * isn't dropped by OCC when a cancel raced the (non-abortable) wallet prompt.
 *
 * If the tx is being cancelled (signal aborted) or the latest record is already terminal — i.e.
 * the user clicked Cancel while the wallet prompt was open and then confirmed anyway — the hash is
 * folded into a `markDismissed` record so the explorer link survives ("Stopped tracking") instead
 * of being thrown away on a hashless cancel. (P0-3 WS1.2c)
 *
 * Threading the returned record forward matters: the stage-entry `record` param is now stale
 * (lower `updatedSeq` than the atom/IDB) and a later `advance` from it would equal-seq write that
 * OCC silently drops, stranding the executor.
 */
export async function recordBroadcastHash<K extends TxKind>(
  record: TxRecord<K>,
  hash: `0x${string}`,
  ctx: ExecutorCtx<K>,
): Promise<BroadcastResult<K>> {
  const store = getDefaultStore()
  const latest = (store.get(txListAtom).find(t => t.id === record.id) as TxRecord<K> | undefined) ?? record
  const withHash = patchArtifacts(latest, { sourceTxHash: hash } as Partial<ArtifactsFor<K>>)
  if (ctx.signal.aborted || isTerminalState(latest.executionState)) {
    const dismissed = markDismissed(withHash)
    await ctx.upsert(dismissed)
    return { record: dismissed, dismissed: true }
  }
  await ctx.upsert(withHash)
  return { record: withHash, dismissed: false }
}
