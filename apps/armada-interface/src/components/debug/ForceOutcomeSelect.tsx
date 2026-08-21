// ABOUTME: DEBUG-only Send control — pick a forced tx outcome so QA/design can see each failed/cancelled/unknown activity state on demand. Renders nothing unless debug mode (?debug) is on.
// ABOUTME: Writes devForceOutcomeAtom; SendModal threads it into the submit meta → the handler throws that exact error (no chain interaction).

import { useAtom, useAtomValue } from 'jotai'
import { debugModeAtom, devForceOutcomeAtom } from '@/state/debug'
import type { TxErrorCode } from '@/lib/tx/types'
import styles from './ForceOutcomeSelect.module.css'

const OPTIONS: ReadonlyArray<{ value: '' | TxErrorCode; label: string }> = [
  { value: '', label: 'Normal (real submit)' },
  { value: 'TX_REVERTED', label: 'TX_REVERTED → Failed' },
  { value: 'PRE_FLIGHT_REVERT', label: 'PRE_FLIGHT_REVERT → Failed' },
  { value: 'RPC_ERROR', label: 'RPC_ERROR → Failed' },
  { value: 'FEE_EXPIRED', label: 'FEE_EXPIRED → Failed' },
  { value: 'INTERRUPTED', label: 'INTERRUPTED → Failed' },
  { value: 'OTHER', label: 'OTHER → Failed' },
  { value: 'USER_REJECTED', label: 'USER_REJECTED → Cancelled' },
  { value: 'CANCELLED', label: 'CANCELLED → Cancelled' },
  { value: 'POLL_TIMEOUT', label: 'POLL_TIMEOUT → Unknown' },
  { value: 'DISMISSED', label: 'DISMISSED → Unknown' },
  { value: 'DUPLICATE_TX', label: 'DUPLICATE_TX → Unknown' },
]

export function ForceOutcomeSelect() {
  const debug = useAtomValue(debugModeAtom)
  const [forced, setForced] = useAtom(devForceOutcomeAtom)
  if (!debug) return null

  return (
    <label className={styles.root}>
      <span className={styles.badge}>DEBUG · force outcome</span>
      <select
        className={styles.select}
        value={forced ?? ''}
        onChange={(e) => setForced(e.target.value === '' ? null : (e.target.value as TxErrorCode))}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
