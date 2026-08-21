// ABOUTME: One-shot "nudge" shake state for incomplete-CTA affordances — trigger a single shake, skip under reduced motion.
// ABOUTME: Returns { shaking, nudge, onShakeAnimationEnd }; wire onShakeAnimationEnd to the shaking element's onAnimationEnd.

import { useCallback, useState, type AnimationEvent } from 'react'

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** One-shot CSS shake class; skipped when the user prefers reduced motion. */
export function useNudgeShake() {
  const [shaking, setShaking] = useState(false)

  const nudge = useCallback(() => {
    if (prefersReducedMotion()) return
    setShaking(false)
    requestAnimationFrame(() => {
      setShaking(true)
    })
  }, [])

  const onShakeAnimationEnd = useCallback((event: AnimationEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return
    setShaking(false)
  }, [])

  return { shaking, nudge, onShakeAnimationEnd }
}
