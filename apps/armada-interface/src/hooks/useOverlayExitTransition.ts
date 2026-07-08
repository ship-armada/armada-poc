// ABOUTME: Keeps overlay/modal mounted through exit CSS — content animates out, then backdrop (mirrors open sequence).
// ABOUTME: `exiting` is derived synchronously when open goes false so exit classes apply on the first paint.

import { useEffect, useState } from 'react'

export interface OverlayExitTransition {
  mounted: boolean
  exiting: boolean
}

export function useOverlayExitTransition(
  open: boolean,
  exitDurationMs: number,
): OverlayExitTransition {
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    if (!mounted) return
    const timer = window.setTimeout(() => {
      setMounted(false)
    }, exitDurationMs)
    return () => window.clearTimeout(timer)
  }, [open, mounted, exitDurationMs])

  return {
    mounted,
    exiting: mounted && !open,
  }
}
