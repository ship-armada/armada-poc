// ABOUTME: Full-area gate shown in place of the dashboard while the initial shielded-balance scan runs or after it fails.
// ABOUTME: Centered progress meter while syncing; a "Try again" button (via useSyncRetry) when the scan failed.

import { useMemo, type CSSProperties } from 'react'
import { useAtomValue } from 'jotai'
import { Button, ArmadaSymbol } from '@/design'
import { syncStateAtom, type SyncState } from '@/state/wallet'
import { useSyncRetry } from '@/hooks/useSyncRetry'
import styles from './SyncGate.module.css'

/** Number of ticks in the animated ring (matches the tx-processing ticker). */
const TICK_COUNT = 60

/** Rotating tick ring with the Armada mark + live percent stacked at its center — the syncing hero. */
function ArmadaTickRing({ pct }: { pct: number }) {
  const ticks = useMemo(() => Array.from({ length: TICK_COUNT }, (_, i) => i), [])
  return (
    <div className={styles.tickRing}>
      {ticks.map((i) => (
        <span key={i} className={styles.tick} style={{ '--i': i } as CSSProperties} aria-hidden />
      ))}
      <ArmadaSymbol size={184} className={styles.ringLogo} />
      <div
        className={styles.pct}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Shielded balance sync progress"
      >
        <span className={styles.pctValue}>
          {pct}
          <span className={styles.pctSymbol}>%</span>
        </span>
      </div>
    </div>
  )
}

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
        <ArmadaTickRing pct={pct} />
        <p className={styles.body}>
          Scanning the chain to load your private balance. This can take a moment.
        </p>
      </div>
    </div>
  )
}
