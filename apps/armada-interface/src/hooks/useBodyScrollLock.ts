// ABOUTME: Hook that prevents background scroll while overlays, sheets, or panels are open.
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect } from 'react'

/** Prevent background scroll while overlays, sheets, or panels are open. */
export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [locked])
}
