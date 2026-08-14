// ABOUTME: Full-area gate shown in place of the dashboard while the initial shielded-balance scan runs or after it fails.
// ABOUTME: Centered progress meter while syncing; a "Try again" button (via useSyncRetry) when the scan failed.

import { useAtomValue } from 'jotai'
import { Button } from '@/design'
import { syncStateAtom, type SyncState } from '@/state/wallet'
import { useSyncRetry } from '@/hooks/useSyncRetry'
import styles from './SyncGate.module.css'

/**
 * Whether the dashboard should be replaced by the sync gate. True until the wallet has a known
 * shielded balance from a completed scan: while the first scan is idle/in-flight/failed,
 * `shielded` is null and the dashboard's numbers would be meaningless, so we gate it.
 */
export function isInitialSyncGated(shielded: bigint | null, status: SyncState['status']): boolean {
  return shielded === null && status !== 'complete'
}

/**
 * The gate body. Reads `syncStateAtom` for live progress (same source as `SyncBanner`). Rendered
 * by the Dashboard when `isInitialSyncGated` is true; the navbar stays visible above it.
 */
export function SyncGate() {
  const sync = useAtomValue(syncStateAtom)
  const retry = useSyncRetry()
  const pct = Math.round(Math.max(0, Math.min(1, sync.progress)) * 100)

  if (sync.status === 'failed') {
    return (
      <div className={styles.root} role="status" aria-live="polite">
        <div className={styles.panel}>
          <h2 className={styles.heading}>Sync interrupted</h2>
          <p className={styles.body}>
            We couldn’t finish loading your private balance — usually a temporary network hiccup.
          </p>
          <Button variant="primary" size="md" label="Try again" showIcon={false} onClick={retry} />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root} role="status" aria-live="polite">
      <div className={styles.panel}>
        <h2 className={styles.heading}>Loading your private balance</h2>
        <div className={styles.pct}>{pct}%</div>
        <div
          className={styles.track}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Shielded balance sync progress"
        >
          <div className={styles.fill} style={{ width: `${pct}%` }} />
        </div>
        <p className={styles.body}>
          First sign-in on this device — we walk the chain from the deploy block so any prior
          activity for your wallet is fully discovered. Subsequent visits are instant.
        </p>
      </div>
    </div>
  )
}
