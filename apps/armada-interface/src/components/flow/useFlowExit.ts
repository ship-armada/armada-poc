// ABOUTME: useFlowExit — plays the modal slide-down (close) animation before running the real close.
// ABOUTME: Holds `exiting` true for MODAL_EXIT_TOTAL_MS so FlowShell can animate out, then invokes onClose.

import { useCallback, useEffect, useRef, useState } from 'react'
import { MODAL_EXIT_TOTAL_MS } from '@/design'

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface FlowExit {
  /** True while the close animation plays. Pass to FlowShell so it keeps rendering + slides out. */
  exiting: boolean
  /** Begin the close animation, then invoke `onClose` once it completes (immediate under reduced motion). */
  requestClose: () => void
}

/**
 * Wraps a flow modal's close so the shell plays its exit animation first. The caller keeps the flow
 * mounted (open) until `onClose` fires — FlowShell renders while `exiting` so the slide-down shows.
 * Under reduced motion the delay is skipped and `onClose` runs synchronously.
 */
export function useFlowExit(onClose: () => void): FlowExit {
  const [exiting, setExiting] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const requestClose = useCallback(() => {
    // Guard re-entry: a second close request while the animation is already running is a no-op.
    if (timerRef.current) return
    if (prefersReducedMotion()) {
      onCloseRef.current()
      return
    }
    setExiting(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setExiting(false)
      onCloseRef.current()
    }, MODAL_EXIT_TOTAL_MS)
  }, [])

  return { exiting, requestClose }
}
