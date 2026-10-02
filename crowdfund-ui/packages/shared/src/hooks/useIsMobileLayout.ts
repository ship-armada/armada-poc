// ABOUTME: Match the crowdfund mobile layout breakpoint (≤767px).
// ABOUTME: Shared by participate full-page shells and other mobile-only presentation.

import { useEffect, useState } from 'react'
import { MOBILE_LAYOUT_MAX_WIDTH_PX } from '../lib/viewportBreakpoints'

export function useIsMobileLayout(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH_PX}px)`).matches
      : false,
  )

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH_PX}px)`)
    const sync = () => setMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  return mobile
}

/** Distance from layout-viewport bottom to visual-viewport bottom (browser chrome gap). */
export function visualViewportBottomInset(): number {
  const vv = window.visualViewport
  if (!vv) return 0
  return Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
}
