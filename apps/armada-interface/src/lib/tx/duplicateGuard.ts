// ABOUTME: S-L7 — detects an unresolved same-amount deposit that may already be on-chain, so the
// ABOUTME: Shield review can warn before the user accidentally deposits twice (POLL_TIMEOUT window).

import type { TxKind, TxRecord } from './types'

const SHIELD_KINDS: ReadonlySet<TxKind> = new Set(['shield', 'shield-xchain'])

/**
 * Is `record` an UNRESOLVED deposit — one that broadcast (has a sourceTxHash) but whose on-chain
 * outcome is still uncertain, so re-depositing the same amount risks a double deposit?
 *
 *  - in flight (pending/active/waiting/retrying) → uncertain (could be a backgrounded tx, S-M2).
 *  - expired with a hash → uncertain (the tx may still land).
 *  - failed with POLL_TIMEOUT → uncertain (we lost the watcher; the deposit may have succeeded).
 *  - failed with TX_REVERTED / INTERRUPTED / anything else → NOT unresolved (no deposit happened).
 *  - completed → resolved success. cancelled/dismissed → the user explicitly dropped it.
 */
function isUnresolvedDeposit(record: TxRecord): boolean {
  if (!SHIELD_KINDS.has(record.kind)) return false
  if (!(record.artifacts as { sourceTxHash?: string }).sourceTxHash) return false
  switch (record.executionState) {
    case 'completed':
    case 'cancelled':
      return false
    case 'failed':
      return record.artifacts.error?.code === 'POLL_TIMEOUT'
    default:
      // pending / active / waiting / retrying / expired — all carry a hash here, all uncertain.
      return true
  }
}

/**
 * True when an unresolved deposit of exactly `amount` already exists — the signal the Shield review
 * uses to surface a non-blocking "may still be processing; submitting again could deposit twice"
 * caution. (S-L7)
 */
export function hasUnresolvedShield(records: ReadonlyArray<TxRecord>, amount: bigint): boolean {
  return records.some(
    (r) => isUnresolvedDeposit(r) && (r.meta as { amount?: bigint }).amount === amount,
  )
}
