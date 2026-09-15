// ABOUTME: Crowdfund progress card — committed amount, gradient fill bar, threshold line, and status tags.
// ABOUTME: Ported from the armada-crowdfund mockup; under 48h remaining the time-left tag is a live HH:MM:SS counter.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BarTrackTicks } from '../BarTrackTicks'
import { Tag, type TagDot } from '../Tag'
import { Tooltip } from '../Tooltip'
import styles from './Progress.module.css'

const TIME_LEFT_COUNTER_THRESHOLD_S = 48 * 60 * 60

function formatTimeLeftCounter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatTimeLeftTag(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds < TIME_LEFT_COUNTER_THRESHOLD_S) return formatTimeLeftCounter(seconds)
  const days = Math.floor(seconds / 86400)
  return `${days} ${days === 1 ? 'DAY' : 'DAYS'} LEFT`
}

function endsAtToRemainingSeconds(endsAt: number | Date, nowMs = Date.now()): number {
  const endMs = typeof endsAt === 'number' ? endsAt : endsAt.getTime()
  return Math.max(0, Math.floor((endMs - nowMs) / 1000))
}

export interface ProgressProps {
  title?: string
  totalCommitted?: string
  committedAmount?: number // raw number e.g. 857000
  minFundAmount?: number // e.g. 1200000
  maxAmount?: number // full bar scale e.g. 1800000
  /** Countdown tag text (e.g. "3 DAYS LEFT"). Pass `null` to suppress.
   *  Ignored when `endsAt` is set. */
  daysLeft?: string | null
  /** Optional exact-time detail shown in a hover tooltip on the countdown tag. */
  daysLeftTooltip?: string
  /**
   * Absolute end of the commit window (unix ms or Date). Under 48h remaining
   * the tag becomes a live HH:MM:SS counter; at ≥ 48h it shows "N DAYS LEFT".
   */
  endsAt?: number | Date | null
  participants?: string
  className?: string
  animateOnMount?: boolean
  hideStatus?: boolean
  status?: string
  statusDot?: TagDot
  /** Optional action aligned with the title (e.g. Claim when finalized). */
  headerAction?: ReactNode
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

function useEndsAtLabel(endsAt: number | Date | null | undefined): string | null | undefined {
  const endMs =
    endsAt == null ? null : typeof endsAt === 'number' ? endsAt : endsAt.getTime()

  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (endMs == null) return
    if (endsAtToRemainingSeconds(endMs, Date.now()) <= 0) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [endMs])

  if (endMs == null) return undefined
  return formatTimeLeftTag(endsAtToRemainingSeconds(endMs, nowMs))
}

export function Progress({
  title = 'Armada Crowdfund',
  totalCommitted,
  committedAmount = 857000,
  minFundAmount = 1200000,
  maxAmount = 1800000,
  daysLeft = '3 DAYS LEFT',
  daysLeftTooltip,
  endsAt = null,
  participants = '85 PARTICIPANTS',
  className,
  animateOnMount = true,
  hideStatus = false,
  status = 'ACTIVE',
  statusDot = 'active',
  headerAction,
}: ProgressProps) {
  const endsAtLabel = useEndsAtLabel(endsAt)
  const timeLeftLabel = endsAt != null ? (endsAtLabel ?? null) : daysLeft

  const endMsForMode =
    endsAt == null ? null : typeof endsAt === 'number' ? endsAt : endsAt.getTime()
  const remainingForMode =
    endMsForMode == null ? 0 : endsAtToRemainingSeconds(endMsForMode)
  const isLiveCounter =
    endMsForMode != null &&
    remainingForMode > 0 &&
    remainingForMode < TIME_LEFT_COUNTER_THRESHOLD_S

  const filledPct = Math.max(0, Math.min(100, (committedAmount / maxAmount) * 100))
  const minFundPct = (minFundAmount / maxAmount) * 100

  const fundedTowardMin = Math.max(
    0,
    Math.min(100, Math.round((committedAmount / minFundAmount) * 100)),
  )
  const leftToMinAmount = Math.max(0, minFundAmount - committedAmount)
  const leftToMin = `$${Math.round(leftToMinAmount / 1000)}k`

  const finalCommittedLabel = useMemo(() => {
    return totalCommitted ?? formatCommitted(committedAmount)
  }, [totalCommitted, committedAmount])

  const [animatedPct, setAnimatedPct] = useState(() => (animateOnMount ? 0 : filledPct))
  const [animatedAmount, setAnimatedAmount] = useState(() =>
    animateOnMount ? 0 : committedAmount,
  )

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

  const gradientFillPct = Math.min(animatedPct, minFundPct)
  const overMinFillPct = Math.max(0, animatedPct - minFundPct)

  return (
    <div
      className={[styles.card, hideStatus && styles.cardSansStatus, className]
        .filter(Boolean)
        .join(' ')}
    >
      {!hideStatus && (
        <div className={styles.status}>
          <div className={styles.titleRow}>
            <p className={styles.title}>{title}</p>
            {headerAction ? <div className={styles.headerAction}>{headerAction}</div> : null}
          </div>
          <div className={styles.tags}>
            <Tag label={status} dot={statusDot} />
            {timeLeftLabel != null &&
              (daysLeftTooltip ? (
                <Tooltip variant="centered" content={daysLeftTooltip} placement="bottom">
                  <Tag
                    label={timeLeftLabel}
                    className={isLiveCounter ? styles.timeCounter : undefined}
                  />
                </Tooltip>
              ) : (
                <Tag
                  label={timeLeftLabel}
                  className={isLiveCounter ? styles.timeCounter : undefined}
                />
              ))}
            <Tag label={participants} />
          </div>
        </div>
      )}

      <div
        className={[
          styles.progressSection,
          hideStatus && styles.progressSectionDashboard,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className={styles.amountBlock}>
          <span className={styles.amountLabel}>Total Committed</span>
          <p className={styles.amount}>
            {animateOnMount ? formatCommitted(animatedAmount) : finalCommittedLabel}
          </p>
        </div>

        <div className={styles.barWrapper}>
          <div className={styles.barTrack}>
            <BarTrackTicks />
            <div className={styles.barFillGradient} style={{ width: `${gradientFillPct}%` }} />
            {overMinFillPct > 0 && (
              <div
                className={styles.barFillOverMin}
                style={{ left: `${minFundPct}%`, width: `${overMinFillPct}%` }}
              />
            )}
            <div className={styles.threshold} style={{ left: `${minFundPct}%` }} />
          </div>

          <div className={styles.barLabels}>
            <div className={styles.labelLeft}>
              <div className={styles.stat}>
                <span className={styles.statValue}>{fundedTowardMin}%</span>
                <span className={styles.statKey}>FUNDED</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{leftToMin}</span>
                <span className={styles.statKey}>LEFT</span>
              </div>
            </div>

            <div className={styles.labelMinFund} style={{ left: `${minFundPct}%` }}>
              <div className={styles.stat}>
                <span className={styles.statValue}>{formatCommitted(minFundAmount)}</span>
                <span className={styles.statKey}>MIN FUND</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
