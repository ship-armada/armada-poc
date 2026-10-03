// ABOUTME: Step-swap timing for multi-step flows — the old step plays its exit, then the new one is shown.
// ABOUTME: Pairs with the frame / frameEnter / frameExit classes in InviteLinkFlowStepTransition.module.css.

import { useEffect, useRef, useState } from 'react'

/** Length of the frameExit animation (stepExit, 240ms) before the swap. */
export const STEP_EXIT_MS = 240

export interface StepTransition<T> {
  /** The step to render — lags `step` by the exit animation. */
  shownStep: T
  /** True while the shown step is animating out ahead of a swap. */
  exiting: boolean
}

/**
 * When `step` changes, keep rendering the previous step (exiting) for
 * STEP_EXIT_MS, then show the new one. The caller keys its frame by
 * `shownStep` so the new step mounts with the enter animation.
 *
 * Changes before the first tick after mount swap at once: that's the flow
 * resolving its starting step (e.g. a connected wallet skipping the connect
 * step), not a user-visible transition.
 */
export function useStepTransition<T>(step: T): StepTransition<T> {
  const [shownStep, setShownStep] = useState(step)
  const settledRef = useRef(false)

  useEffect(() => {
    settledRef.current = false
    const timer = setTimeout(() => {
      settledRef.current = true
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (Object.is(step, shownStep)) return
    if (!settledRef.current) {
      setShownStep(step)
      return
    }
    const timer = setTimeout(() => setShownStep(step), STEP_EXIT_MS)
    return () => clearTimeout(timer)
  }, [step, shownStep])

  return { shownStep, exiting: !Object.is(step, shownStep) }
}
