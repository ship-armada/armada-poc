// ABOUTME: Dashboard "Recent Activity" card — terminal-state TxRecords from txListAtom, most-recent first, capped at 5.
// ABOUTME: Each row is a TxRow; click navigates to /history (the parent handles routing via the onSelect prop).

import { useAtomValue } from 'jotai'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card, EmptyState, SectionHeader } from '@/components/ui'
import { TxRow } from '@/components/tx'
import { activeTxListAtom } from '@/state/tx'
import { History } from 'lucide-react'
import type { TxRecord, TxExecutionState } from '@/lib/tx/types'
import styles from './RecentActivityCard.module.css'

const TERMINAL_STATES: ReadonlySet<TxExecutionState> = new Set([
  'completed',
  'failed',
  'expired',
  'cancelled',
])

const MAX_ROWS = 5

export interface RecentActivityCardProps {
  /** Called when a row is selected. Parent handles navigation/expansion. */
  onSelect?: (record: TxRecord) => void
}

export function RecentActivityCard({ onSelect }: RecentActivityCardProps) {
  const list = useAtomValue(activeTxListAtom)
  const rows = useMemo(() => {
    return list
      .filter(t => TERMINAL_STATES.has(t.executionState))
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ROWS)
  }, [list])

  return (
    <Card className={styles.card}>
      <SectionHeader
        title="Recent activity"
        trailing={
          rows.length > 0 ? (
            <Link to="/history" className={styles.viewAll}>
              View all
            </Link>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          icon={<History size={28} />}
          title="No activity yet"
          description="Your completed deposits, withdrawals, and transfers will appear here."
        />
      ) : (
        <ul className={styles.list}>
          {rows.map(record => (
            <li key={record.id}>
              <TxRow record={record} onClick={onSelect ? () => onSelect(record) : undefined} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
