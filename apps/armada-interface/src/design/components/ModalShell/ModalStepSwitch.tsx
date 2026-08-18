// ABOUTME: Plays a short content exit then mounts the next modal step so enter animations replay.
// ABOUTME: Ported from the armada-app design mockup; keeps header/steps in place across step changes.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { MODAL_STEP_EXIT_MS } from './modalExitMotion'
import styles from './ModalShell.module.css'

export interface ModalStepSwitchProps {
  /** Stable id for the current step (same as the old `key` on the step shell). */
  stepKey: string
  children: ReactNode
  /** When the whole modal is closing, skip step exit — overlay/content exit owns motion. */
  skipExit?: boolean
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Plays a short content exit, then mounts the next step so enter animations run.
 * Header/steps stay put. First step still waits `--modal-step-enter-delay` (header).
 */
export function ModalStepSwitch({ stepKey, children, skipExit = false }: ModalStepSwitchProps) {
  const liveRef = useRef(children)
  liveRef.current = children

  const displayedKeyRef = useRef(stepKey)
  const pendingKeyRef = useRef(stepKey)
  const phaseRef = useRef<'idle' | 'exit'>('idle')
  const timerRef = useRef<number | null>(null)

  const [displayedKey, setDisplayedKey] = useState(stepKey)
  const [displayed, setDisplayed] = useState(children)
  const [phase, setPhase] = useState<'idle' | 'exit'>('idle')
  const [followUp, setFollowUp] = useState(false)

  function showLive(nextKey: string) {
    displayedKeyRef.current = nextKey
    pendingKeyRef.current = nextKey
    phaseRef.current = 'idle'
    setDisplayedKey(nextKey)
    setDisplayed(liveRef.current)
    setPhase('idle')
  }

  useLayoutEffect(() => {
    if (skipExit || prefersReducedMotion()) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (stepKey !== displayedKeyRef.current) setFollowUp(true)
      showLive(stepKey)
      return
    }

    if (stepKey === displayedKeyRef.current) return

    pendingKeyRef.current = stepKey
    if (phaseRef.current === 'exit') return

    phaseRef.current = 'exit'
    setPhase('exit')
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setFollowUp(true)
      showLive(pendingKeyRef.current)
    }, MODAL_STEP_EXIT_MS)
  }, [stepKey, skipExit])

  useLayoutEffect(() => {
    if (phase !== 'idle') return
    if (stepKey !== displayedKey) return
    setDisplayed(children)
  }, [children, phase, stepKey, displayedKey])

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const className = [
    styles.stepShell,
    phase === 'exit' ? styles.stepShellExit : '',
    followUp && phase !== 'exit' ? styles.stepShellFollowup : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      style={{ '--modal-step-exit-ms': `${MODAL_STEP_EXIT_MS}ms` } as CSSProperties}
    >
      {displayed}
    </div>
  )
}
