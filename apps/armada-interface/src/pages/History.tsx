// ABOUTME: Activity (History) page — filter chips + list of TxRows with click-to-expand TxLifecycleStepper.
// ABOUTME: Reads activeTxListAtom (scoped to the active shielded wallet — V2 Phase 6) so a wallet switch doesn't leak prior history. Single-row expansion at a time. Pagination deferred — shows up to MAX_ROWS recent records.

import { useAtomValue } from 'jotai'
import { useMemo, useState } from 'react'
import { History as HistoryIcon } from 'lucide-react'
import { Card, EmptyState, SectionHeader, Tabs, type TabItem } from '@/components/ui'
import { TxActions, TxLifecycleStepper, TxRow } from '@/components/tx'
import { activeTxListAtom } from '@/state/tx'
import { preferencesAtom } from '@/state/preferences'
import type { TxExecutionState, TxRecord } from '@/lib/tx/types'
import styles from './History.module.css'

type FilterId = 'all' | 'pending' | 'complete' | 'failed'

const FILTERS: ReadonlyArray<TabItem<FilterId>> = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'complete', label: 'Complete' },
  { id: 'failed', label: 'Failed' },
]

const MAX_ROWS = 50

const PENDING_STATES: ReadonlySet<TxExecutionState> = new Set([
  'pending',
  'active',
  'waiting',
  'retrying',
])
const FAILED_STATES: ReadonlySet<TxExecutionState> = new Set([
  'failed',
  'expired',
  'cancelled',
])

function matches(record: TxRecord, filter: FilterId): boolean {
  if (filter === 'all') return true
  if (filter === 'pending') return PENDING_STATES.has(record.executionState)
  if (filter === 'complete') return record.executionState === 'completed'
  return FAILED_STATES.has(record.executionState)
}

export function History() {
  const all = useAtomValue(activeTxListAtom)
  const prefs = useAtomValue(preferencesAtom)
  const [filter, setFilter] = useState<FilterId>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const rows = useMemo(() => {
    return all
      .filter(r => matches(r, filter))
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ROWS)
  }, [all, filter])

  function toggle(id: string) {
    setExpandedId(prev => (prev === id ? null : id))
  }

  return (
    <div className={styles.page}>
      <SectionHeader title="Activity" />
      <Tabs
        items={FILTERS}
        selected={filter}
        onSelect={setFilter}
        ariaLabel="Activity filter"
        className={styles.filters}
      />
      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HistoryIcon size={28} />}
            title="No matching activity"
            description={filter === 'all'
              ? 'Your transactions will appear here as they happen.'
              : 'Try a different filter to see other transactions.'}
          />
        </Card>
      ) : (
        <Card className={styles.listCard}>
          <ul className={styles.list}>
            {rows.map(record => {
              const isExpanded = expandedId === record.id
              return (
                <li key={record.id} className={styles.item}>
                  <TxRow record={record} onClick={() => toggle(record.id)} />
                  {isExpanded ? (
                    <div className={styles.detail}>
                      <TxLifecycleStepper
                        record={record}
                        technicalDetailsDefaultOpen={prefs.showTechnicalDetailsByDefault}
                      />
                      <TxActions record={record} />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </Card>
      )}
    </div>
  )
}
