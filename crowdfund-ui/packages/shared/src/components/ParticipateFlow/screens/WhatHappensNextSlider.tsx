// ABOUTME: Confirmation “What happens next” FAQ accordion — one topic per row.
// ABOUTME: Ported from the armada-crowdfund mockup (replaces the old chevron carousel); countdown helpers come from `lib/format`.

import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import {
  endsAtToRemainingSeconds,
  formatTimeLeft,
  TIME_LEFT_COUNTER_THRESHOLD_S,
} from '../../../lib/format'
import styles from './WhatHappensNextSlider.module.css'

export interface WhatHappensNextSliderProps {
  /**
   * Whole days remaining (demo / URL). Ignored when `endsAt` or `secondsLeft`
   * is set. Converted to an absolute deadline so the copy can live-tick under 48h.
   * With no countdown input at all, the copy names no deadline.
   */
  daysLeft?: number
  /** Remaining seconds in the commit window. Prefer `endsAt` when available. */
  secondsLeft?: number
  /** Absolute end of the commit window (unix ms or Date). */
  endsAt?: number | Date | null
}

type Item = { id: string; title: string; body: string }

function resolveEndMs(
  endsAt: number | Date | null | undefined,
  secondsLeft: number | undefined,
  daysLeft: number | undefined,
): number | null {
  if (endsAt != null) {
    return typeof endsAt === 'number' ? endsAt : endsAt.getTime()
  }
  if (secondsLeft != null && Number.isFinite(secondsLeft)) {
    return Date.now() + Math.max(0, secondsLeft) * 1000
  }
  if (daysLeft != null && Number.isFinite(daysLeft) && daysLeft > 0) {
    return Date.now() + daysLeft * 86400 * 1000
  }
  return null
}

function windowOpenBody(remainingLabel: string | null): string {
  if (remainingLabel) {
    return `The commitment window closes in ${remainingLabel}. Your USDC will be locked until then.`
  }
  return 'The commitment window is closing. Your USDC will be locked until then.'
}

const STATIC_ITEMS: ReadonlyArray<Omit<Item, 'body'> & { body?: string }> = [
  {
    id: 'window',
    title: 'While the window is open',
  },
  {
    id: 'under',
    title: 'If undersubscribed',
    body: 'If total demand misses the minimum raise, the sale refunds. You reclaim your full USDC — no ARM is issued.',
  },
  {
    id: 'over',
    title: 'If oversubscribed',
    body: 'If demand exceeds supply, ARM is allocated pro-rata. You may receive less than “up to” your estimate; unused USDC is refunded when you claim.',
  },
  {
    id: 'refund',
    title: 'If the sale refunds after allocation',
    body: 'Sometimes demand qualifies but net proceeds still fall short. In that case everyone can reclaim their full USDC — no ARM is issued.',
  },
  {
    id: 'claim',
    title: 'Claim & delegate',
    body: 'After a successful finalization, claim your ARM and choose a delegate in one step. Any refund USDC comes back in the same flow.',
  },
]

/** @deprecated Name kept for import stability — renders as a FAQ accordion. */
export function WhatHappensNextSlider({
  daysLeft,
  secondsLeft,
  endsAt = null,
}: WhatHappensNextSliderProps) {
  const baseId = useId()
  const [openId, setOpenId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const endMs = useMemo(
    () => resolveEndMs(endsAt, secondsLeft, daysLeft),
    // Re-anchor only when the source countdown inputs change — not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Date.now() anchor for secondsLeft/daysLeft
    [endsAt, secondsLeft, daysLeft],
  )

  const windowOpen = openId === 'window'

  useEffect(() => {
    if (endMs == null || !windowOpen) return
    if (endsAtToRemainingSeconds(endMs, Date.now()) <= 0) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [endMs, windowOpen])

  const remainingLabel = useMemo(() => {
    if (endMs == null) return null
    const remaining = endsAtToRemainingSeconds(endMs, nowMs)
    const label = formatTimeLeft(remaining)
    return label || null
  }, [endMs, nowMs])

  const isLiveCounter = useMemo(() => {
    if (endMs == null) return false
    const remaining = endsAtToRemainingSeconds(endMs, nowMs)
    return remaining > 0 && remaining < TIME_LEFT_COUNTER_THRESHOLD_S
  }, [endMs, nowMs])

  const items: ReadonlyArray<Item> = useMemo(
    () =>
      STATIC_ITEMS.map((item) =>
        item.id === 'window'
          ? { id: item.id, title: item.title, body: windowOpenBody(remainingLabel) }
          : { id: item.id, title: item.title, body: item.body! },
      ),
    [remainingLabel],
  )

  return (
    <div className={styles.root}>
      <p className={styles.sectionLabel} id={`${baseId}-label`}>
        What happens next
      </p>
      <ul className={styles.faqList} aria-labelledby={`${baseId}-label`}>
        {items.map((item) => {
          const expanded = openId === item.id
          const panelId = `${baseId}-${item.id}-panel`
          const buttonId = `${baseId}-${item.id}-btn`
          return (
            <li key={item.id} className={styles.faqItem}>
              <button
                type="button"
                id={buttonId}
                className={styles.faqToggle}
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => setOpenId(expanded ? null : item.id)}
              >
                <span className={styles.faqTitle}>{item.title}</span>
                <ChevronDownIcon
                  className={[styles.chevron, expanded && styles.chevronOpen]
                    .filter(Boolean)
                    .join(' ')}
                  aria-hidden
                />
              </button>
              {expanded ? (
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  className={styles.faqPanel}
                  aria-live={item.id === 'window' && isLiveCounter ? 'off' : 'polite'}
                >
                  <p className={styles.faqBody}>{item.body}</p>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
