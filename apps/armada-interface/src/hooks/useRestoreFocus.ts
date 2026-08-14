// ABOUTME: React hook that returns focus to the previously-active element when a modal/dialog closes.
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, useRef } from 'react'

/** Return focus to the element that was active when `active` became true. */
export function useRestoreFocus(active: boolean) {
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    return () => {
      const target = previousFocusRef.current
      if (!target || !document.contains(target)) return
      target.focus({ preventScroll: true })
    }
  }, [active])
}
