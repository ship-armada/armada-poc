// ABOUTME: Search input for filtering activity by transaction hash — controlled value + onChange.
// ABOUTME: Ported from the armada-app design mockup; monospace input with a leading magnifier icon.

import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import styles from './ActivityTxHashSearch.module.css'

export interface ActivityTxHashSearchProps {
  value: string
  onChange: (value: string) => void
}

export function ActivityTxHashSearch({ value, onChange }: ActivityTxHashSearchProps) {
  return (
    <label className={styles.root}>
      <span className={styles.field}>
        <MagnifyingGlassIcon className={styles.icon} strokeWidth={1.75} aria-hidden />
        <input
          className={styles.input}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Paste transaction hash"
          spellCheck={false}
          autoComplete="off"
          inputMode="search"
          aria-label="Search by transaction hash"
        />
      </span>
    </label>
  )
}
