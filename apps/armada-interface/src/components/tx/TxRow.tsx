// ABOUTME: Compact row representation of a TxRecord — leading kind glyph, title (+ optional progress), signed amount, time or status chip.
// ABOUTME: Inflows (shield/yield-withdraw) render green with a + prefix; outflows render default-color with a − prefix.

import {
  ArrowDown,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Inbox,
  Plus,
  type LucideIcon,
} from 'lucide-react'
import { useAtomValue } from 'jotai'
import { lifecycleFor } from '@/lib/tx/lifecycles'
import { formatUsdc, formatRelativeTime } from '@/lib/format'
import { nowAtom } from '@/state/time'
import type { TxKind, TxRecord } from '@/lib/tx/types'
import { TxStatusChip } from './TxStatusChip'
import { stageCopy, recordTitle } from './stageCopy'
import styles from './TxRow.module.css'

/**
 * Lavender leading glyph per kind. Mirrors the icons used in ActionGrid/ActionCard so the
 * Recent Activity row visually links back to whichever action initiated the tx.
 *  - shield(-xchain)        Plus — money coming into private balance.
 *  - unshield-*             ArrowDown — withdrawal to wallet.
 *  - transfer-shielded      ArrowRight — payment.
 *  - yield-deposit          ArrowUpRight — into vault.
 *  - yield-withdraw         ArrowDownLeft — vault → available shielded.
 *  - transfer-received      Inbox — someone shielded USDC to us (ties to the Receive button glyph).
 */
function kindIcon(kind: TxKind): LucideIcon {
  switch (kind) {
    case 'shield':
    case 'shield-xchain':
      return Plus
    case 'unshield-local':
    case 'unshield-xchain':
      return ArrowDown
    case 'transfer-shielded':
      return ArrowRight
    case 'transfer-shielded-received':
      return Inbox
    case 'yield-deposit':
      return ArrowUpRight
    case 'yield-withdraw':
      return ArrowDownLeft
  }
}

/** Whether the tx adds to (true) or removes from (false) the user's private balance. */
function isInflow(kind: TxKind): boolean {
  return (
    kind === 'shield'
    || kind === 'shield-xchain'
    || kind === 'yield-withdraw'
    || kind === 'transfer-shielded-received'
  )
}

export interface TxRowProps {
  record: TxRecord
  /**
   * Show the current stage copy as a sub-line beneath the title. Default false.
   * InProgressCard sets true; History list leaves false.
   */
  showStageCopy?: boolean
  /**
   * Render a thin progress bar showing stagesCompleted / total stages. Default false.
   * InProgressCard sets true; History list leaves false.
   */
  showProgress?: boolean
  onClick?: () => void
  className?: string
}

export function TxRow({
  record,
  showStageCopy = false,
  showProgress = false,
  onClick,
  className,
}: TxRowProps) {
  const lifecycle = lifecycleFor(record.kind)
  // `nowAtom` is bumped every 60s by useNowTicker (App root). Reading it here causes a row
  // re-render alongside the bump so "3m ago" labels stay current without user navigation.
  const now = useAtomValue(nowAtom)
  const cls = [styles.root, onClick ? styles.clickable : '', className].filter(Boolean).join(' ')

  const title = recordTitle(record)
  const subline =
    showStageCopy && (record.executionState === 'completed'
      ? null
      : stageCopy(record.kind, record.stage as string, record.executionState))

  const completedCount = record.stagesCompleted.length
  const stageCount = lifecycle.stages.length
  const progressTotal = stageCount
  const progressCurrent =
    record.executionState === 'completed' ? progressTotal : completedCount

  const Tag = onClick ? 'button' : 'div'

  const Icon = kindIcon(record.kind)
  const inflow = isInflow(record.kind)
  // Direction is conveyed by the leading kind glyph and the amount color (inflows green,
  // outflows default) — no need for a leading + / − character.
  const formattedAmount = formatUsdc(record.meta.amount)
  const amountCls = [styles.amount, inflow ? styles.amountInflow : ''].filter(Boolean).join(' ')

  // Completed is the common case — drop the chip and surface only the relative time. For any
  // non-completed terminal state (failed/expired/cancelled) the chip carries real information
  // and replaces the time slot.
  const showChip = record.executionState !== 'completed'

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cls}
    >
      <span className={styles.icon} aria-hidden="true">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <div className={styles.body}>
        <span className={styles.title}>{title}</span>
        {showStageCopy && subline ? (
          <div className={styles.subline}>{subline}</div>
        ) : null}
        {showProgress ? (
          <div className={styles.progressRow}>
            <div className={styles.track}>
              {Array.from({ length: progressTotal }).map((_, i) => (
                <div
                  key={i}
                  className={[styles.tick, i < progressCurrent ? styles.tickFilled : ''].filter(Boolean).join(' ')}
                />
              ))}
            </div>
            <span className={styles.progressCount}>
              {progressCurrent}/{progressTotal}
            </span>
          </div>
        ) : null}
      </div>
      <div className={styles.meta}>
        <span className={amountCls}>{formattedAmount}</span>
        {showChip ? (
          <TxStatusChip state={record.executionState} error={record.artifacts.error ?? null} />
        ) : (
          <span className={styles.time}>{formatRelativeTime(record.updatedAt, now)}</span>
        )}
      </div>
    </Tag>
  )
}
