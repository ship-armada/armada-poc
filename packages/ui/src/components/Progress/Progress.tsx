// ABOUTME: Crowdfund progress card — committed amount, gradient fill bar, threshold line, and status tags.
// ABOUTME: Ported from the armada-crowdfund mockup; under 48h remaining the time-left tag is a live HH:MM:SS counter.

import {
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
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

function formatTimeLeftTag(seconds: number, countdown: ProgressCountdown): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  // 'opens' (pre-open) mode is a deviation from the mockup, which has no
  // pre-open state: the tag counts down to the window opening instead.
  if (seconds < TIME_LEFT_COUNTER_THRESHOLD_S) {
    const counter = formatTimeLeftCounter(seconds)
    return countdown === 'opens' ? `OPENS IN ${counter}` : counter
  }
  const days = Math.floor(seconds / 86400)
  const dayLabel = `${days} ${days === 1 ? 'DAY' : 'DAYS'}`
  return countdown === 'opens' ? `OPENS IN ${dayLabel}` : `${dayLabel} LEFT`
}

function endsAtToRemainingSeconds(endsAt: number | Date, nowMs = Date.now()): number {
  const endMs = typeof endsAt === 'number' ? endsAt : endsAt.getTime()
  return Math.max(0, Math.floor((endMs - nowMs) / 1000))
}

/** What `endsAt` counts down to: the window closing ('ends', the default) or,
 *  before the sale starts, the window opening ('opens'). */
export type ProgressCountdown = 'ends' | 'opens'

export interface ProgressProps {
  title?: string
  totalCommitted?: string
  committedAmount?: number // raw number e.g. 857000
  /** The "100% funded" point: the tick on the bar, and what FUNDED / LEFT measure toward. */
  goalAmount?: number // e.g. 750000
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
  /** Countdown wording for `endsAt` — "N DAYS LEFT" ('ends') or
   *  "OPENS IN N DAYS" ('opens'). Defaults to 'ends'. */
  countdown?: ProgressCountdown
  participants?: string
  className?: string
  animateOnMount?: boolean
  hideStatus?: boolean
  status?: string
  statusDot?: TagDot
  /** Optional action aligned with the title (e.g. Claim when finalized). */
  headerAction?: ReactNode
}

// Deviation from the mockup, which abbreviated to $Nk / $N.NM: the crowdfund
// shows the exact committed amount, rounded to the nearest dollar.
function formatCommitted(amount: number) {
  if (!Number.isFinite(amount)) return '$0'
  return `$${Math.round(amount).toLocaleString('en-US')}`
}

/** Short dollar form for headline amounts: "$1.8M", "$250K", "$0". Mirrors formatUsdcShort in
 *  @armada/crowdfund-shared, which this package cannot import. */
function formatShortDollars(amount: number) {
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, '')
  if (amount >= 1_000_000) return `$${trim(amount / 1_000_000)}M`
  if (amount >= 1_000) return `$${trim(amount / 1_000)}K`
  return formatCommitted(amount)
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3)
}

function useEndsAtLabel(
  endsAt: number | Date | null | undefined,
  countdown: ProgressCountdown,
): string | null | undefined {
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
  return formatTimeLeftTag(endsAtToRemainingSeconds(endMs, nowMs), countdown)
}

export function Progress({
  title = 'Armada Crowdfund',
  totalCommitted,
  committedAmount = 857000,
  goalAmount = 1200000,
  maxAmount = 1800000,
  daysLeft = '3 DAYS LEFT',
  daysLeftTooltip,
  endsAt = null,
  countdown = 'ends',
  participants = '85 PARTICIPANTS',
  className,
  animateOnMount = true,
  hideStatus = false,
  status = 'ACTIVE',
  statusDot = 'active',
  headerAction,
}: ProgressProps) {
  const endsAtLabel = useEndsAtLabel(endsAt, countdown)
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
  const goalPct = (goalAmount / maxAmount) * 100

  // FUNDED and LEFT measure progress toward the goal (the tick). FUNDED is not capped at 100%:
  // commitments can run past the goal up to the bar's maximum. LEFT is hidden once the goal is
  // met. Deviation from the mockup port, which capped FUNDED at 100% and always showed LEFT.
  const fundedTowardGoal = Math.max(0, Math.round((committedAmount / goalAmount) * 100))
  const leftToGoalAmount = Math.max(0, goalAmount - committedAmount)
  const leftToGoal = formatShortDollars(leftToGoalAmount)

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

  const gradientFillPct = Math.min(animatedPct, goalPct)
  const overGoalFillPct = Math.max(0, animatedPct - goalPct)

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
            {overGoalFillPct > 0 && (
              <div
                className={styles.barFillOverMin}
                style={{ left: `${goalPct}%`, width: `${overGoalFillPct}%` }}
              />
            )}
            <div className={styles.threshold} style={{ left: `${goalPct}%` }} />
          </div>

          <div className={styles.barLabels}>
            <div className={styles.labelLeft}>
              <div className={styles.stat}>
                <span className={styles.statValue}>{fundedTowardGoal}%</span>
                <span className={styles.statKey}>FUNDED</span>
              </div>
              {leftToGoalAmount > 0 && (
                <div className={styles.stat}>
                  <span className={styles.statValue}>{leftToGoal}</span>
                  <span className={styles.statKey}>LEFT</span>
                </div>
              )}
            </div>
            {/* The goal is shown only as the threshold marker on the bar, with no label.
                Deviation from the mockup port: a floating label there overlapped the FUNDED /
                LEFT stats whenever the marker sat near the start of the bar. */}
          </div>
        </div>

        {headerAction && isValidElement(headerAction) ? (
          <div className={styles.footerAction}>
            {cloneElement(headerAction as ReactElement)}
          </div>
        ) : null}
      </div>
    </div>
  )
}
