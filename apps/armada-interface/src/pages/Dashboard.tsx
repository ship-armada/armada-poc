// ABOUTME: Dashboard page — BalanceHero + ActionGrid + RecentActivity. The visual anchor of the app.
// ABOUTME: The In-Progress side + footnote tagline are temporarily commented out below; uncomment to restore the 7/5 split layout.

import { BalanceHero } from '@/components/balance/BalanceHero'
import { ActionGrid, RecentActivityCard } from '@/components/dashboard'
// TODO: re-import `InProgressCard` from '@/components/dashboard' when re-enabling the split layout below.
import styles from './Dashboard.module.css'

export function Dashboard() {
  return (
    <div className={styles.page}>
      <BalanceHero />
      <ActionGrid />
      <RecentActivityCard />
      {/* In-Progress section + 7/5 split — temporarily hidden. To restore:
            1. re-import InProgressCard above
            2. delete the standalone <RecentActivityCard /> above
            3. uncomment the block below
          The `.split`, `.activity`, and `.progress` CSS classes are left intact in
          Dashboard.module.css so the swap is purely a JSX edit.
        ----------------------------------------------------------------------------------
          <div className={styles.split}>
            <div className={styles.activity}>
              <RecentActivityCard />
            </div>
            <div className={styles.progress}>
              <InProgressCard />
            </div>
          </div>
       */}
      {/* Privacy tagline — temporarily hidden; uncomment to restore.
          <p className={styles.footnote}>
            Your privacy is protected. All transactions are shielded.
          </p>
       */}
    </div>
  )
}
