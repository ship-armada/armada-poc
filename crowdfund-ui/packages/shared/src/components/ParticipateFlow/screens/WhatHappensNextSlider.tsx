// ABOUTME: Confirmation “What happens next” carousel — scenarios after commit (window, under/over, refund, claim).
// ABOUTME: Manual navigation via chevrons only (no dots / autoplay).

import { useCallback, useId, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import styles from './WhatHappensNextSlider.module.css'

const SLIDES: ReadonlyArray<{ id: string; title: string; body: string }> = [
  {
    id: 'window',
    title: '1. While the window is open',
    body: 'The commitment window stays open until it closes. Your USDC is locked; estimated ARM isn’t final until then.',
  },
  {
    id: 'under',
    title: '2. If undersubscribed',
    body: 'If total demand misses the minimum raise, the sale refunds. You reclaim your full USDC — no ARM is issued.',
  },
  {
    id: 'over',
    title: '3. If oversubscribed',
    body: 'If demand exceeds supply, ARM is allocated pro-rata. You may receive less than “up to” your estimate; unused USDC is refunded when you claim.',
  },
  {
    id: 'refund',
    title: '4. If the sale refunds after allocation',
    body: 'Sometimes demand qualifies but net proceeds still fall short. In that case everyone can reclaim their full USDC — no ARM is issued.',
  },
  {
    id: 'claim',
    title: '5. Claim & delegate',
    body: 'After a successful finalization, claim your ARM and choose a delegate in one step. Any refund USDC comes back in the same flow.',
  },
]

export function WhatHappensNextSlider() {
  const labelId = useId()
  const [index, setIndex] = useState(0)
  const count = SLIDES.length
  const slide = SLIDES[index]!

  const go = useCallback(
    (next: number) => {
      setIndex(((next % count) + count) % count)
    },
    [count],
  )

  const goPrev = useCallback(() => go(index - 1), [go, index])
  const goNext = useCallback(() => go(index + 1), [go, index])

  return (
    <div
      className={styles.root}
      role="region"
      aria-roledescription="carousel"
      aria-labelledby={labelId}
    >
      <div className={styles.header}>
        <span id={labelId} className={styles.eyebrow}>
          WHAT HAPPENS NEXT
        </span>
        <div className={styles.chevronGroup}>
          <button
            type="button"
            className={styles.chevronBtn}
            aria-label="Previous slide"
            onClick={goPrev}
          >
            <ChevronLeftIcon className={styles.chevronIcon} aria-hidden />
          </button>
          <button
            type="button"
            className={styles.chevronBtn}
            aria-label="Next slide"
            onClick={goNext}
          >
            <ChevronRightIcon className={styles.chevronIcon} aria-hidden />
          </button>
        </div>
      </div>

      <div
        className={styles.slide}
        aria-live="polite"
        aria-atomic="true"
        key={slide.id}
      >
        <p className={styles.slideTitle}>{slide.title}</p>
        <p className={styles.slideBody}>{slide.body}</p>
      </div>
    </div>
  )
}
