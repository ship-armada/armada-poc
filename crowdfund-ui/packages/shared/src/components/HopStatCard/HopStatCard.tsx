// ABOUTME: Per-hop demand card — label + amount + accented progress bar + ceiling/cap footer.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; BarTrackTicks now imported from @armada/ui.

import { BarTrackTicks } from '@armada/ui'
import styles from './HopStatCard.module.css'

export type HopStatAccent = 'lavender' | 'amber' | 'orange'

export interface HopStatCardProps {
  label: string
  amount: string
  filledPct: number
  pctOfCeiling: number
  cap: string
  accent?: HopStatAccent
  className?: string
}

const ACCENT_FILL: Record<HopStatAccent, string> = {
  lavender: 'var(--primitives-color-purple-500)',
  amber: 'linear-gradient(to right, var(--primitives-color-amber-400) 0%, var(--primitives-color-amber-300) 100%)',
  orange: 'linear-gradient(to right, var(--primitives-color-amber-500) 0%, var(--primitives-color-amber-400) 100%)',
}

export function HopStatCard({
  label,
  amount,
  filledPct,
  pctOfCeiling,
  cap,
  accent = 'lavender',
  className,
}: HopStatCardProps) {
  return (
    <div className={[styles.card, className].filter(Boolean).join(' ')}>
      <p className={styles.label}>{label}</p>
      <p className={styles.amount}>{amount}</p>
      <div className={styles.barTrack}>
        <BarTrackTicks />
        <div
          className={styles.fill}
          style={{
            width: `${Math.min(100, Math.max(0, filledPct))}%`,
            background: ACCENT_FILL[accent],
          }}
        />
      </div>
      <div className={styles.footer}>
        <span className={styles.footerLeft}>{pctOfCeiling}% OF CEILING</span>
        <span className={styles.footerRight}>CAP {cap}</span>
      </div>
    </div>
  )
}
