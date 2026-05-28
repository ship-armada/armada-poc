// ABOUTME: Crowdfund progress card — committed amount, gradient fill bar, threshold line, and status tags.
// ABOUTME: Ported byte-identical from the mockup; rAF-driven count-up animation preserved.

import { useEffect, useMemo, useState } from 'react'
import { BarTrackTicks } from '../BarTrackTicks'
import { Tag } from '../Tag'
import styles from './Progress.module.css'

export interface ProgressProps {
  title?: string
  totalCommitted?: string
  committedAmount?: number  // raw number e.g. 857000
  minRaiseAmount?: number   // e.g. 1200000
  maxAmount?: number        // full bar scale e.g. 1800000
  daysLeft?: string
  participants?: string
  className?: string
  animateOnMount?: boolean
  /** Hide title + status tags (e.g. dashboard layout with headline outside the card). */
  hideStatus?: boolean
}

function formatCommitted(amount: number) {
  if (!Number.isFinite(amount)) return '$0'
  const abs = Math.abs(amount)
  if (abs >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 1_000) return `$${Math.round(amount / 1_000)}k`
  return `$${Math.round(amount)}`
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3)
}

export function Progress({
  title = 'Armada Crowdfund',
  totalCommitted,
  committedAmount = 857000,
  minRaiseAmount = 1200000,
  maxAmount = 1800000,
  daysLeft = '3 DAYS LEFT',
  participants = '85 PARTICIPANTS',
  className,
  animateOnMount = true,
  hideStatus = false,
}: ProgressProps) {
  // Bar position calculations
  const filledPct = Math.max(0, Math.min(100, (committedAmount / maxAmount) * 100))
  const minRaisePct = (minRaiseAmount / maxAmount) * 100       // ~66.7%

  // Labels
  const raisedTowardMin = Math.max(0, Math.min(100, Math.round((committedAmount / minRaiseAmount) * 100)))
  const leftToMinAmount = Math.max(0, minRaiseAmount - committedAmount)
  const leftToMin = `$${Math.round(leftToMinAmount / 1000)}k`

  const finalCommittedLabel = useMemo(() => {
    // Prefer explicit label if consumer provided it, otherwise derive from numeric value.
    return totalCommitted ?? formatCommitted(committedAmount)
  }, [totalCommitted, committedAmount])

  const [animatedPct, setAnimatedPct] = useState(() => (animateOnMount ? 0 : filledPct))
  const [animatedAmount, setAnimatedAmount] = useState(() => (animateOnMount ? 0 : committedAmount))

  useEffect(() => {
    if (!animateOnMount) {
      setAnimatedPct(filledPct)
      setAnimatedAmount(committedAmount)
      return
    }

    let raf = 0
    const start = performance.now()
    const durationMs = 1100

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const e = easeOutCubic(t)
      setAnimatedPct(filledPct * e)
      setAnimatedAmount(committedAmount * e)
      if (t < 1) raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [animateOnMount, filledPct, committedAmount])

  const gradientFillPct = Math.min(animatedPct, minRaisePct)
  const overMinFillPct = Math.max(0, animatedPct - minRaisePct)

  return (
    <div className={[styles.card, hideStatus && styles.cardSansStatus, className].filter(Boolean).join(' ')}>

      {!hideStatus && (
        <div className={styles.status}>
          <p className={styles.title}>{title}</p>
          <div className={styles.tags}>
            <Tag label="ACTIVE" dot="active" />
            <Tag label={daysLeft} />
            <Tag label={participants} />
          </div>
        </div>
      )}

      {/* Amount + progress */}
      <div className={[styles.progressSection, hideStatus && styles.progressSectionDashboard].filter(Boolean).join(' ')}>
        <div className={styles.amountBlock}>
          <span className={styles.amountLabel}>Total Committed</span>
          <p className={styles.amount}>
            {animateOnMount ? formatCommitted(animatedAmount) : finalCommittedLabel}
          </p>
        </div>

        {/* Bar wrapper — threshold line positioned relative to this */}
        <div className={styles.barWrapper}>

          {/* Bar track */}
          <div className={styles.barTrack}>
            {/* Fixed tick grid; fill is painted above and covers the filled segment */}
            <BarTrackTicks />
            {/* Gradient up to min raise; lavender beyond */}
            <div className={styles.barFillGradient} style={{ width: `${gradientFillPct}%` }} />
            {overMinFillPct > 0 && (
              <div
                className={styles.barFillOverMin}
                style={{ left: `${minRaisePct}%`, width: `${overMinFillPct}%` }}
              />
            )}
            {/* Threshold line — taller than bar */}
            <div className={styles.threshold} style={{ left: `${minRaisePct}%` }} />
          </div>

          {/* Labels */}
          <div className={styles.barLabels}>
            {/* Left labels */}
            <div className={styles.labelLeft}>
              <div className={styles.stat}>
                <span className={styles.statValue}>{raisedTowardMin}%</span>
                <span className={styles.statKey}>RAISED</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{leftToMin}</span>
                <span className={styles.statKey}>LEFT</span>
              </div>
            </div>

            {/* Min raise label — pinned under threshold line */}
            <div
              className={styles.labelMinRaise}
              style={{ left: `${minRaisePct}%` }}
            >
              <div className={styles.stat}>
                <span className={styles.statValue}>{formatCommitted(minRaiseAmount)}</span>
                <span className={styles.statKey}>MIN RAISE</span>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
