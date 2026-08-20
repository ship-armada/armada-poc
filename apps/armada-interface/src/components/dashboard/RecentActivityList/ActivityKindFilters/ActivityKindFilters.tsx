// ABOUTME: Segmented kind-filter chips for the activity panel — All / Deposit / Withdraw / Sent / Requests / Received / Earn.
// ABOUTME: Ported from the armada-app mockup; the chip id equals the activity kind so the predicate is a direct match.

import styles from './ActivityKindFilters.module.css'

export type ActivityKindFilter =
  | 'all'
  | 'deposit'
  | 'withdraw'
  | 'send'
  | 'requestLink'
  | 'receive'
  | 'earn'

const FILTERS: Array<{ id: ActivityKindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'deposit', label: 'Deposit' },
  { id: 'withdraw', label: 'Withdraw' },
  { id: 'send', label: 'Sent' },
  { id: 'requestLink', label: 'Requests' },
  { id: 'receive', label: 'Received' },
  { id: 'earn', label: 'Earn' },
]

export interface ActivityKindFiltersProps {
  value: ActivityKindFilter
  onChange: (value: ActivityKindFilter) => void
}

export function ActivityKindFilters({ value, onChange }: ActivityKindFiltersProps) {
  return (
    <div className={styles.root} role="tablist" aria-label="Filter by transaction type">
      {FILTERS.map((filter) => {
        const isActive = value === filter.id
        return (
          <button
            key={filter.id}
            type="button"
            className={[styles.filterBtn, isActive && styles.filterBtnActive].filter(Boolean).join(' ')}
            onClick={() => onChange(filter.id)}
            role="tab"
            aria-selected={isActive}
          >
            {filter.label}
          </button>
        )
      })}
    </div>
  )
}
