// ABOUTME: Dashboard page — BalanceHero + ActionGrid + RecentActivity. The visual anchor of the app.
// ABOUTME: The In-Progress side + footnote tagline are temporarily commented out below; uncomment to restore the 7/5 split layout.

import { useAtomValue } from 'jotai'
import { BalanceHero } from '@/components/balance/BalanceHero'
import { ActionGrid, InProgressCard, RecentActivityCard } from '@/components/dashboard'
import { SyncGate, isInitialSyncGated } from '@/components/sync'
import { shieldedUsdcAtom, syncStateAtom } from '@/state/wallet'
import styles from './Dashboard.module.css'

export function Dashboard() {
  // Gate the whole dashboard body behind the initial shielded-balance sync — until the first scan
  // completes we don't know the user's balance, so the hero/actions/activity would show
  // placeholder/zero values. The navbar (in AppLayout) stays visible above this.
  const shielded = useAtomValue(shieldedUsdcAtom)
  const sync = useAtomValue(syncStateAtom)
  if (isInitialSyncGated(shielded, sync.status)) {
    return <SyncGate />
  }

  return (
    <div className={styles.page}>
      {/* Decorative top-of-page gradient — purple → pink fading into the page background.
          Fixed-positioned + pointer-events: none so it doesn't intercept clicks. Scoped to
          the Dashboard page only; other routes stay flat. */}
      <div className={styles.backdrop} aria-hidden />
      {/* Hero + actions share a row on desktop: BalanceHero on the left at a fixed-ish width,
          the 3-up ActionGrid filling the rest. Stacks vertically under 900px. */}
      <div className={styles.heroRow}>
        <BalanceHero />
        <ActionGrid />
      </div>
      {/* In-Progress (live, non-terminal txs) beside Recent Activity (terminal). S-M2 re-enables
          this — backgrounded txs (dismissed from a modal's progress step) surface in InProgressCard. */}
      <div className={styles.split}>
        <div className={styles.activity}>
          <RecentActivityCard />
        </div>
        <div className={styles.progress}>
          <InProgressCard />
        </div>
      </div>
      {/* Privacy tagline — temporarily hidden; uncomment to restore.
          <p className={styles.footnote}>
            Your privacy is protected. All transactions are shielded.
          </p>
       */}
    </div>
  )
}
