// ABOUTME: Header banner that surfaces the Railgun engine's UTXO merkletree scan state.
// ABOUTME: Hidden when sync is idle or complete; visible (with progress bar) while syncing or after a failure.

import { useAtomValue } from 'jotai'
import { syncStateAtom } from '@/state/wallet'
import styles from './SyncBanner.module.css'

/**
 * Thin banner that appears below the app header during initial shielded-balance sync.
 *
 * - `syncing` → "Loading your private balance — N%. Subsequent visits will be much faster."
 *   Includes a progress bar driven by the SDK's MerkletreeScanStatus progress value.
 * - `failed` → "Sync interrupted. Reload to retry." with a manual retry CTA hint.
 * - `idle` / `complete` → not rendered (banner area collapses to nothing).
 *
 * Reads syncStateAtom directly because it lives at the app-chrome layer (AppLayout renders it
 * unconditionally). Per components/CLAUDE.md, atom reads at the chrome level are fine — the
 * "no atoms in leaf components" rule targets reusable UI primitives, not app-shell pieces.
 */
export function SyncBanner() {
  const sync = useAtomValue(syncStateAtom)

  if (sync.status === 'idle' || sync.status === 'complete') return null

  const pct = Math.round(Math.max(0, Math.min(1, sync.progress)) * 100)

  if (sync.status === 'failed') {
    return (
      <div className={`${styles.banner} ${styles.failed}`} role="status" aria-live="polite">
        <span className={styles.message}>Sync interrupted. Reload the page to retry.</span>
      </div>
    )
  }

  return (
    <div className={`${styles.banner} ${styles.syncing}`} role="status" aria-live="polite">
      <span className={styles.message}>
        First sign-in on this device — loading your private balance ({pct}%). This walks the
        chain from deploy so any prior activity for your wallet is fully discovered. Subsequent
        visits are instant.
      </span>
      <span
        className={styles.progressTrack}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Shielded balance sync progress"
      >
        <span className={styles.progressFill} style={{ width: `${pct}%` }} />
      </span>
    </div>
  )
}
