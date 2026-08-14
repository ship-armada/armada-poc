// ABOUTME: Maps TxRecords to the dashboard RecentActivityList's presentational item shape.
// ABOUTME: Direction (icon kind + amount sign) per TxKind; label reuses the app's recordTitle; folds in pending txs.

import type { TxRecord, TxKind } from '@/lib/tx/types'
import { historySortTime, isTerminalState } from '@/lib/tx/types'
import { recordTitle } from '@/components/tx/stageCopy'

/** Icon/semantic kind for an activity row — a coarser grouping than TxKind. */
export type DashboardActivityKind = 'send' | 'deposit' | 'earn' | 'withdraw' | 'receive'

export interface DashboardActivityItem {
  id: string
  kind: DashboardActivityKind
  label: string
  /** Signed USDC amount as a plain number: positive = inflow, negative = outflow. */
  amount: number
  occurredAt: number
  txHash?: string
  /** True while the underlying tx is non-terminal (still in flight). */
  pending: boolean
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

export function txRecordToActivityItem(record: TxRecord): DashboardActivityItem {
  const direction = DIRECTION[record.kind]
  return {
    id: record.id,
    kind: direction.kind,
    label: recordTitle(record),
    amount: direction.sign * usdcToNumber(record.meta.amount),
    occurredAt: historySortTime(record),
    txHash: record.artifacts.sourceTxHash,
    pending: !isTerminalState(record.executionState),
  }
}

/**
 * Adapt the active-wallet tx list to dashboard activity items — newest first, capped.
 * Includes both terminal history and in-flight (pending) txs (fold-in per the dashboard redesign).
 */
export function txListToActivityItems(
  list: readonly TxRecord[],
  max = 8,
): DashboardActivityItem[] {
  return [...list]
    .sort((a, b) => historySortTime(b) - historySortTime(a))
    .slice(0, max)
    .map(txRecordToActivityItem)
}
