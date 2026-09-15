// ABOUTME: Modal shell for the Path 2 (hero-entry) Participate flow — portal-rendered backdrop + panel with optional close / footer.
// ABOUTME: Ported from the armada-crowdfund mockup; keeps confirm-before-close while a tx pipeline runs.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { XMarkIcon } from '@heroicons/react/24/outline'
import armadaSymbol from '../../assets/armada-symbol-color.png'
import styles from './ParticipateFlowModal.module.css'

const EXIT_MS = 280

const CLOSE_CONFIRM_MESSAGE =
  'A transaction is still running. It will continue, and you can reopen Participate to finish the remaining steps. Close?'

export interface ParticipateFlowModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** Accessible name for the dialog (e.g. step headline). */
  ariaLabel: string
  /** When true, Escape / the X button ask for confirmation before closing —
   *  used while an approve/commit pipeline is in flight. */
  confirmBeforeClose?: boolean
  /** When false, hides the top-right close control (e.g. invite uses “Do it later”). */
  showClose?: boolean
  /** Optional content below the step shell (e.g. “Do it later” text link). */
  footer?: ReactNode
}

export function ParticipateFlowModal({
  open,
  onClose,
  children,
  ariaLabel,
  confirmBeforeClose = false,
  showClose = true,
  footer,
}: ParticipateFlowModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  // Hold `onClose` in a ref so the focus + keydown effect below can read the
  // latest callback without listing it as a dependency. Parents typically pass
  // an inline arrow (`() => setOpen(false)`) — including it as a dep would
  // re-run the effect on every parent render and steal focus back to the
  // close button while the user is typing in a field.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Held in a ref for the same reason as onClose — the keydown effect reads the
  // latest value without re-subscribing.
  const confirmBeforeCloseRef = useRef(confirmBeforeClose)
  useEffect(() => {
    confirmBeforeCloseRef.current = confirmBeforeClose
  }, [confirmBeforeClose])

  // Confirm before closing if a transaction is in flight, so Escape / X can't
  // silently unmount the modal mid-pipeline.
  const requestClose = () => {
    if (confirmBeforeCloseRef.current && !window.confirm(CLOSE_CONFIRM_MESSAGE)) return
    onCloseRef.current()
  }

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

    // Lock page scroll while the modal is open. `overflow: hidden` alone is not
    // enough on iOS / when the hero page scrolls the document — pin the body
    // and restore scroll position on close.
    const html = document.documentElement
    const body = document.body
    const scrollY = window.scrollY
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
    }
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'

    if (showClose) {
      closeRef.current?.focus()
    } else {
      const focusable = footerRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      focusable?.focus()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Read refs directly so this effect needn't depend on requestClose.
      if (confirmBeforeCloseRef.current && !window.confirm(CLOSE_CONFIRM_MESSAGE)) return
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      html.style.overflow = prev.htmlOverflow
      body.style.overflow = prev.bodyOverflow
      body.style.position = prev.bodyPosition
      body.style.top = prev.bodyTop
      body.style.left = prev.bodyLeft
      body.style.right = prev.bodyRight
      body.style.width = prev.bodyWidth
      window.scrollTo(0, scrollY)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [mounted, exiting, showClose])

  if (!mounted) return null

  return createPortal(
    <div
      className={[styles.backdrop, exiting && styles.backdropExit].join(' ')}
      role="presentation"
    >
      <img
        src={armadaSymbol}
        alt=""
        width={40}
        height={40}
        className={styles.mobileLogo}
        aria-hidden
      />
      <div
        className={[
          styles.panel,
          !showClose && styles.panelNoClose,
          exiting && styles.panelExit,
        ]
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        {showClose ? (
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            onClick={requestClose}
            aria-label="Close participate flow"
          >
            <XMarkIcon width={20} height={20} aria-hidden />
          </button>
        ) : null}
        <div className={[styles.step, exiting && styles.stepExit].filter(Boolean).join(' ')}>
          {children}
        </div>
        {footer ? (
          <div ref={footerRef} className={styles.footer}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
