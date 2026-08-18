// ABOUTME: Portaled, blurred backdrop dialog wrapper for flow modals — scroll lock, focus trap, escape, restore focus.
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useNestedDialogCount } from '@/hooks/nestedDialog'
import { useRestoreFocus } from '@/hooks/useRestoreFocus'
import styles from './FlowModalOverlay.module.css'

export interface FlowModalOverlayProps {
  /** Accessible name for the dialog (e.g. "Deposit", "Send"). */
  label: string
  exiting?: boolean
  onClose: () => void
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Skip overlay fade-in (e.g. Shield ↔ Unshield handoff). */
  skipEnter?: boolean
  style?: CSSProperties
  children: ReactNode
}

export function FlowModalOverlay({
  label,
  exiting = false,
  onClose,
  initialFocusRef,
  skipEnter = false,
  style,
  children,
}: FlowModalOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const nestedDialogCount = useNestedDialogCount()
  const focusTrapActive = nestedDialogCount === 0

  useBodyScrollLock(true)
  useRestoreFocus(true)
  useEscapeKey(onClose, !exiting)
  useFocusTrap(dialogRef, focusTrapActive && !exiting)

  useEffect(() => {
    if (exiting || !focusTrapActive) return
    const target = initialFocusRef?.current ?? dialogRef.current
    target?.focus({ preventScroll: true })
  }, [exiting, focusTrapActive, initialFocusRef])

  const overlayClassName = [
    styles.overlay,
    skipEnter && styles.overlaySkipEnter,
    exiting && styles.overlayExiting,
  ]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <div className={overlayClassName} style={style}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-hidden={nestedDialogCount > 0 ? true : undefined}
        className={styles.dialog}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
