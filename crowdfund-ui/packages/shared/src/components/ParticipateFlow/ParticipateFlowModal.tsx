// ABOUTME: Modal shell for the Path 2 (hero-entry) Participate flow — portal-rendered backdrop + panel with close button.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup (ParticipateFlow/ParticipateFlowModal.tsx).

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { XMarkIcon } from '@heroicons/react/24/outline'
import styles from './ParticipateFlowModal.module.css'

const EXIT_MS = 280

export interface ParticipateFlowModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** Accessible name for the dialog (e.g. step headline). */
  ariaLabel: string
}

export function ParticipateFlowModal({
  open,
  onClose,
  children,
  ariaLabel,
}: ParticipateFlowModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setExiting(false)
      return
    }
    if (!mounted) return
    setExiting(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setExiting(false)
    }, EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  useEffect(() => {
    if (!mounted || exiting) return

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [mounted, exiting, onClose])

  if (!mounted) return null

  return createPortal(
    <div
      className={[styles.backdrop, exiting && styles.backdropExit].join(' ')}
      role="presentation"
    >
      <div
        className={[styles.panel, exiting && styles.panelExit].join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <button
          ref={closeRef}
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close participate flow"
        >
          <XMarkIcon width={16} height={16} aria-hidden />
        </button>
        <div className={[styles.step, exiting && styles.stepExit].join(' ')}>{children}</div>
      </div>
    </div>,
    document.body,
  )
}
