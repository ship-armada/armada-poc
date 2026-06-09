// ABOUTME: Slim banner reading historyRecoveryAtom — shows "Recovering activity from chain…" while scanning and a "Recovery failed" notice on error. Hidden otherwise.
// ABOUTME: Mounted in AppLayout alongside SyncBanner so the user gets a uniform "we're working on it" status strip regardless of route.

import { useAtomValue, useSetAtom } from 'jotai'
import { historyRecoveryAtom, historyRecoveryEpochAtom } from '@/state/history'
import styles from './HistoryRecoveryBanner.module.css'

/**
 * Three states drive rendering:
 *   - `scanning` → narrow blue strip "Recovering activity from chain…"
 *   - `failed`   → red strip with a Retry CTA that bumps the epoch atom so the scan re-fires
 *   - `idle`     → not rendered
 *
 * Behaves like SyncBanner: atom reads at the chrome layer are allowed (per
 * components/CLAUDE.md the no-atoms-in-leaves rule applies to design-system primitives, not
 * app-shell pieces).
 */
export function HistoryRecoveryBanner() {
  const recovery = useAtomValue(historyRecoveryAtom)
  const setEpoch = useSetAtom(historyRecoveryEpochAtom)

  if (recovery.state === 'idle') return null

  if (recovery.state === 'failed') {
    return (
      <div className={`${styles.banner} ${styles.failed}`} role="status" aria-live="polite">
        <span className={styles.message}>
          Couldn't recover activity from chain. {recovery.error ?? ''}
        </span>
        <button
          type="button"
          className={styles.retry}
          onClick={() => setEpoch((prev) => prev + 1)}
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className={`${styles.banner} ${styles.scanning}`} role="status" aria-live="polite">
      <span className={styles.message}>Recovering activity from chain…</span>
    </div>
  )
}
