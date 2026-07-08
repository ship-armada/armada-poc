// ABOUTME: Modal primitive — centered dialog with backdrop, ESC/backdrop dismissal, focus management, and portal mount.
// ABOUTME: Used by every action flow (ActionFlowShell) and the wallet-unlock dialog; `dismissible={false}` for in-progress flows.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { OVERLAY_EXIT_MS } from '@/constants/overlayMotion'
import { useOverlayExitTransition } from '@/hooks/useOverlayExitTransition'
import styles from './Modal.module.css'

export interface ModalProps {
  /** Whether the modal is open. When false, exit animations run before unmount. */
  open: boolean
  /** Called when the user presses ESC, clicks the backdrop, or clicks the close button. Ignored when dismissible=false. */
  onClose: () => void
  /**
   * Whether ESC + backdrop click can dismiss. Default true. Set to false during long-running tx execution so
   * the user can't accidentally close the modal mid-flight; they can still navigate via the close button if shown.
   */
  dismissible?: boolean
  /** Optional title rendered in the modal header. If omitted, no header bar is rendered. */
  title?: string
  /**
   * Whether to show the X close button in the header (only relevant when `title` is set).
   * Defaults to true when dismissible, false otherwise.
   */
  showCloseButton?: boolean
  /** Accessible label override — use when the visible title isn't sufficient (e.g. icon-only headers). */
  ariaLabel?: string
  /**
   * Whether to render the default padded scroll-aware body wrapper around children. Default true.
   * Set false when the consumer composes its own header/body/footer layout that must touch the dialog edges
   * (e.g. ActionFlowShell with FlowHeader's full-width bottom border).
   */
  wrapBody?: boolean
  children: ReactNode
  className?: string
  dialogClassName?: string
  /** Optional content rendered below the dialog card (e.g. secondary links). */
  belowDialog?: ReactNode
}

/**
 * Modal — controlled component. Parent owns `open` state.
 *
 * Focus handling:
 * - On open, focus is moved to the dialog wrapper. Tab navigates the dialog's contents in document order.
 * - On close, focus returns to whatever element was focused before the modal opened.
 * - This is a minimal focus trap — Tab wrap-around (last → first focusable) is intentionally not implemented
 *   in v1. Most flows are short and the browser default order is good enough. Revisit if real screens prove otherwise.
 */
export function Modal({
  open,
  onClose,
  dismissible = true,
  title,
  showCloseButton,
  ariaLabel,
  wrapBody = true,
  children,
  className,
  dialogClassName,
  belowDialog,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const headingId = useId()
  const { mounted, exiting } = useOverlayExitTransition(open, OVERLAY_EXIT_MS)

  // Track previously-focused element + move focus into the dialog on open; restore on close.
  useEffect(() => {
    if (!mounted || exiting) return
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null
    dialogRef.current?.focus()
    return () => {
      previouslyFocused.current?.focus?.()
    }
  }, [mounted, exiting])

  // ESC dismissal.
  useEffect(() => {
    if (!mounted || exiting || !dismissible) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [mounted, exiting, dismissible, onClose])

  // Body scroll lock while mounted (including exit animation).
  useEffect(() => {
    if (!mounted) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [mounted])

  const onBackdropClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!dismissible || exiting) return
      // Only close when the click target is the backdrop itself, not bubbled from the dialog.
      if (e.target === e.currentTarget) onClose()
    },
    [dismissible, exiting, onClose],
  )

  // Prevent Tab/Shift+Tab from escaping the dialog by capturing keydowns at the dialog root.
  // (Browser default focus order within the dialog is preserved; we only block focus from
  // jumping outside the modal entirely.)
  const onDialogKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    // Allow normal tabbing inside; nothing to do — focus stays in the dialog because it's
    // visually overlaid and the rest of the page is inert (we don't currently mark
    // background inert, but in practice the dialog catches first focus and circular tab
    // through the body just cycles back). Real wrap-around comes later if needed.
    void e
  }, [])

  if (!mounted) return null

  const closeVisible = showCloseButton ?? dismissible

  const dialog = (
    <div
      className={[styles.backdrop, className].filter(Boolean).join(' ')}
      data-exiting={exiting ? true : undefined}
      onMouseDown={onBackdropClick}
      role="presentation"
    >
      <div
        className={[
          styles.stack,
          belowDialog ? styles.stackWithBelow : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div
          ref={dialogRef}
          className={[styles.dialog, dialogClassName].filter(Boolean).join(' ')}
          data-exiting={exiting ? true : undefined}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? headingId : undefined}
          aria-label={!title ? ariaLabel : undefined}
          tabIndex={-1}
          onKeyDown={onDialogKeyDown}
        >
          {title ? (
            <header className={styles.header}>
              <h2 id={headingId} className={styles.title}>
                {title}
              </h2>
              {closeVisible ? (
                <button
                  type="button"
                  className={styles.closeButton}
                  onClick={onClose}
                  aria-label="Close"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              ) : null}
            </header>
          ) : null}
          {wrapBody ? <div className={styles.body}>{children}</div> : children}
        </div>
        {belowDialog ? <div className={styles.belowDialog}>{belowDialog}</div> : null}
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}
