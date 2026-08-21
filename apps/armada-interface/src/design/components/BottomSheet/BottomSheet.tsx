// ABOUTME: Portal-rendered mobile bottom sheet with slide-in/out animation and scrim.
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import styles from './BottomSheet.module.css'

/** Matches `.sheetExit` slide duration. */
export const BOTTOM_SHEET_EXIT_MS = 320
/** Pause after a sheet finishes closing before opening another. */
export const BOTTOM_SHEET_HANDOFF_MS = 160

/** Run `callback` after the exit animation plus handoff gap. */
export function afterBottomSheetHandoff(callback: () => void): number {
  return window.setTimeout(callback, BOTTOM_SHEET_HANDOFF_MS)
}

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  /** Fires after the close animation finishes (when `open` becomes false). */
  onExited?: () => void
  title?: string
  ariaLabel?: string
  /** When `title` is set, show the header close control. Default true. */
  showClose?: boolean
  sheetClassName?: string
  headerClassName?: string
  bodyClassName?: string
  scrimClassName?: string
  children: ReactNode
}

export function BottomSheet({
  open,
  onClose,
  onExited,
  title,
  ariaLabel,
  showClose = true,
  sheetClassName,
  headerClassName,
  bodyClassName,
  scrimClassName,
  children,
}: BottomSheetProps) {
  const titleId = useId()
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  const onCloseRef = useRef(onClose)
  const onExitedRef = useRef(onExited)
  onCloseRef.current = onClose
  onExitedRef.current = onExited

  useBodyScrollLock(open || exiting)
  useEscapeKey(onClose, mounted && !exiting)

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
      onExitedRef.current?.()
    }, BOTTOM_SHEET_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  if (!mounted) return null

  const scrimClassNameResolved = [styles.scrim, scrimClassName, exiting && styles.scrimExit]
    .filter(Boolean)
    .join(' ')
  const sheetClassNameResolved = [styles.sheet, sheetClassName, exiting && styles.sheetExit]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <div className={scrimClassNameResolved} role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        className={sheetClassNameResolved}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.handleRow} aria-hidden>
          <span className={styles.handle} />
        </div>

        {title ? (
          <div className={[styles.header, headerClassName].filter(Boolean).join(' ')}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {showClose ? (
              <button type="button" className={styles.closeButton} aria-label="Close" onClick={onClose}>
                <XMarkIcon width={20} height={20} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className={[styles.body, bodyClassName].filter(Boolean).join(' ')}>{children}</div>
      </div>
    </div>,
    document.body,
  )
}
