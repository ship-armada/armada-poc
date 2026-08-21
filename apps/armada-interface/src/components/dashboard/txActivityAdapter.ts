// ABOUTME: Maps TxRecords to the dashboard RecentActivityList's presentational item shape.
// ABOUTME: Direction (icon kind + amount sign) per TxKind; label reuses the app's recordTitle; folds in pending txs.

import type { TxRecord, TxKind, TxErrorCode } from '@/lib/tx/types'
import { historySortTime, isTerminalState } from '@/lib/tx/types'
import { recordTitle } from '@/components/tx/stageCopy'
import type { RequestLinkRecord } from '@/lib/shielded/requestLinks'

/** Icon/semantic kind for an activity row — a coarser grouping than TxKind. */
export type DashboardActivityKind = 'send' | 'deposit' | 'earn' | 'withdraw' | 'receive' | 'requestLink'

/**
 * Outcome bucket for an activity row.
 *   settled   — completed on chain.
 *   pending   — still in flight.
 *   failed    — definitively failed; nothing settled (revert / reject / pre-flight / interrupted / fee-expired / rpc).
 *   cancelled — user cancelled before anything was sent.
 *   unknown   — we stopped watching (timeout / dismissed / duplicate / expired); it MAY still have
 *               settled on chain, so we never present these as "failed".
 */
export type DashboardActivityStatus = 'settled' | 'pending' | 'failed' | 'cancelled' | 'unknown'

/** Error codes whose outcome is indeterminate — the tx may still have landed. */
const INDETERMINATE_CODES: ReadonlySet<TxErrorCode> = new Set([
  'POLL_TIMEOUT',
  'DISMISSED',
  'DUPLICATE_TX',
])

export interface DashboardActivityItem {
  id: string
  kind: DashboardActivityKind
  label: string
  /** Signed USDC amount as a plain number: positive = inflow, negative = outflow. `requestLink`
   *  rows render this neutrally (no sign/tone) — a created link moves no funds. */
  amount: number
  occurredAt: number
  txHash?: string
  /** Outcome bucket — drives the row's status label + amount treatment. */
  status: DashboardActivityStatus
  /** True while the underlying tx is non-terminal (still in flight). Kept as a convenience alias
   *  for `status === 'pending'`. */
  pending: boolean
  /** `requestLink` only — the request id (re-opens the Share step) + expiry (row subtitle). */
  requestId?: string
  expiresAt?: number
}

/**
 * Reduce a record's executionState + error code to an outcome bucket. Keyed off `error.code` for
 * the terminal cases so a DISMISSED (had broadcast → may complete) isn't confused with a CANCELLED
 * (nothing sent), and so timeouts/expiry never read as a hard failure.
 */
export function deriveActivityStatus(record: TxRecord): DashboardActivityStatus {
  const state = record.executionState
  if (state === 'completed') return 'settled'
  if (!isTerminalState(state)) return 'pending'
  const code = record.artifacts.error?.code
  // The error CODE is authoritative for the outcome bucket — the executionState machinery can land
  // the same code on either `cancelled` or `failed` (e.g. a thrown CANCELLED routes through
  // markFailed), so we key off the code first and fall back to the state.
  // Indeterminate — we stopped watching; the tx may still have settled on chain. Never "failed".
  if (state === 'expired' || (code !== undefined && INDETERMINATE_CODES.has(code))) return 'unknown'
  // User-initiated aborts, nothing sent: the app Cancel button (CANCELLED / `cancelled` state) AND a
  // declined wallet prompt (USER_REJECTED). Group as "Cancelled" — matches the modal's "Action
  // declined — nothing submitted" framing.
  if (state === 'cancelled' || code === 'CANCELLED' || code === 'USER_REJECTED') return 'cancelled'
  return 'failed'
}

/** Per-TxKind direction: the activity icon-kind and the sign of the amount (inflow vs outflow). */
const DIRECTION: Record<TxKind, { kind: DashboardActivityKind; sign: 1 | -1 }> = {
  shield: { kind: 'deposit', sign: 1 },
  'shield-xchain': { kind: 'deposit', sign: 1 },
  'unshield-local': { kind: 'withdraw', sign: -1 },
  'unshield-xchain': { kind: 'withdraw', sign: -1 },
  'transfer-shielded': { kind: 'send', sign: -1 },
  'transfer-shielded-received': { kind: 'receive', sign: 1 },
  'yield-deposit': { kind: 'earn', sign: -1 },
  'yield-withdraw': { kind: 'earn', sign: 1 },
}

/** USDC is a 6-decimal bigint; the activity list renders plain numbers. */
function usdcToNumber(amount: bigint): number {
  return Number(amount) / 1e6
}

/**
 * An `unshield-*` record covers BOTH "send to an external wallet" and "withdraw to your own wallet"
 * — the same on-chain op, and the record doesn't store which the user intended. Heuristic: it's a
 * withdraw when the recipient equals the user's own connected wallet, otherwise a send. This is the
 * only signal available for chain-recovered txs too (the flow variant is never on-chain).
 */
export function isWithdrawToSelf(
  recipient: string | undefined,
  ownWallet: string | null | undefined,
): boolean {
  return Boolean(ownWallet && recipient && recipient.toLowerCase() === ownWallet.toLowerCase())
}

export function txRecordToActivityItem(
  record: TxRecord,
  ownWallet?: string | null,
): DashboardActivityItem {
  const status = deriveActivityStatus(record)
  const base = {
    id: record.id,
    occurredAt: historySortTime(record),
    txHash: record.artifacts.sourceTxHash,
    status,
    pending: status === 'pending',
  }

  // Public unshields split into send-vs-withdraw by the recipient heuristic (both share this kind).
  if (record.kind === 'unshield-local' || record.kind === 'unshield-xchain') {
    const recipient = (record.meta as { recipient?: string }).recipient
    const withdraw = isWithdrawToSelf(recipient, ownWallet)
    return {
      ...base,
      kind: withdraw ? 'withdraw' : 'send',
      label: withdraw ? 'Withdrawn to your wallet' : recordTitle(record),
      amount: -usdcToNumber(record.meta.amount),
    }
  }

  const direction = DIRECTION[record.kind]
  return {
    ...base,
    kind: direction.kind,
    label: recordTitle(record),
    amount: direction.sign * usdcToNumber(record.meta.amount),
  }
}

/**
 * Adapt the active-wallet tx list to dashboard activity items — newest first, capped.
 * Includes both terminal history and in-flight (pending) txs (fold-in per the dashboard redesign).
 */
export function txListToActivityItems(
  list: readonly TxRecord[],
  ownWallet?: string | null,
  max = 8,
): DashboardActivityItem[] {
  return [...list]
    .sort((a, b) => historySortTime(b) - historySortTime(a))
    .slice(0, max)
    .map((record) => txRecordToActivityItem(record, ownWallet))
}

/** A created payment-request link as an activity row. Neutral amount; clicking re-opens the link. */
export function requestLinkToActivityItem(link: RequestLinkRecord): DashboardActivityItem {
  const amount = Number(link.amount)
  return {
    id: link.requestId,
    kind: 'requestLink',
    label: 'Payment link created',
    amount: Number.isFinite(amount) ? amount : 0,
    occurredAt: link.createdAt,
    status: 'settled',
    pending: false,
    requestId: link.requestId,
    expiresAt: link.expiresAt,
  }
}

/** Merge tx-derived + request-link activity rows into one newest-first list, capped. */
export function buildActivityItems(
  list: readonly TxRecord[],
  links: readonly RequestLinkRecord[],
  ownWallet?: string | null,
  max = 8,
): DashboardActivityItem[] {
  const items = [
    ...list.map((record) => txRecordToActivityItem(record, ownWallet)),
    ...links.map(requestLinkToActivityItem),
  ]
  return items.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, max)
}
