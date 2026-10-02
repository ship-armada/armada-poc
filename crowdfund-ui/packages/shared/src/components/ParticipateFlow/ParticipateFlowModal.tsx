// ABOUTME: Modal shell for the Path 2 (hero-entry) Participate flow — portal-rendered backdrop + panel with optional close / footer.
// ABOUTME: Ported from the armada-crowdfund mockup; keeps confirm-before-close while a tx pipeline runs.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { XMarkIcon } from '@heroicons/react/24/outline'
import armadaSymbol from '../../assets/armada-symbol-color.png'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'
import styles from './ParticipateFlowModal.module.css'

const EXIT_MS = 280
const MODAL_OPEN_ATTR = 'data-flow-modal-open'

const CLOSE_CONFIRM_MESSAGE =
  'A transaction is still running. It will continue, and you can reopen Participate to finish the remaining steps. Close?'

/**
 * Whether the participate flow may close. While a tx pipeline is running, asks
 * the user first. Shared by the modal's X / Escape and the in-flow FlowChrome X
 * so every close control asks the same question.
 */
export function confirmParticipateClose(
  running: boolean,
  message: string = CLOSE_CONFIRM_MESSAGE,
): boolean {
  return !running || window.confirm(message)
}

export interface ParticipateFlowModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** Accessible name for the dialog (e.g. step headline). */
  ariaLabel: string
  /** When true, Escape / the X button ask for confirmation before closing —
   *  used while an approve/commit pipeline is in flight. */
  confirmBeforeClose?: boolean
  /** Prompt for `confirmBeforeClose`. Defaults to the participate wording;
   *  other flows hosted in this shell (e.g. Claim) pass their own. */
  closeConfirmMessage?: string
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
  closeConfirmMessage,
  showClose = true,
  footer,
}: ParticipateFlowModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const stepRef = useRef<HTMLDivElement>(null)
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
  const closeConfirmMessageRef = useRef(closeConfirmMessage)
  useEffect(() => {
    closeConfirmMessageRef.current = closeConfirmMessage
  }, [closeConfirmMessage])

  // Confirm before closing if a transaction is in flight, so Escape / X can't
  // silently unmount the modal mid-pipeline.
  const requestClose = () => {
    if (!confirmParticipateClose(confirmBeforeCloseRef.current, closeConfirmMessageRef.current)) return
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

    // Page scroll is locked by `useBodyScrollLock` below; this marks the page
    // as behind a modal and makes it inert.
    const html = document.documentElement
    const root = document.getElementById('root')
    const prevRootInert = root?.inert ?? false
    html.setAttribute(MODAL_OPEN_ATTR, '')
    if (root) root.inert = true

    // Move focus into the dialog. Steps that draw their own chrome (FlowChrome's
    // back / close) leave `showClose` false and render no footer, so fall
    // through to the step's first control rather than leaving focus on the
    // trigger behind the backdrop.
    if (showClose) {
      closeRef.current?.focus()
    } else {
      const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      const focusable =
        footerRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        stepRef.current?.querySelector<HTMLElement>(FOCUSABLE)
      focusable?.focus()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // A sheet / menu layered over the modal handles Escape first (capture
      // phase) and marks it — it closes that layer, not the modal.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Read refs directly so this effect needn't depend on requestClose.
      if (!confirmParticipateClose(confirmBeforeCloseRef.current, closeConfirmMessageRef.current)) return
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      html.removeAttribute(MODAL_OPEN_ATTR)
      if (root) root.inert = prevRootInert
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [mounted, exiting, showClose])

  useBodyScrollLock(mounted && !exiting)

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
            <XMarkIcon width={14} height={14} aria-hidden />
          </button>
        ) : null}
        <div
          ref={stepRef}
          className={[styles.step, exiting && styles.stepExit].filter(Boolean).join(' ')}
        >
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
