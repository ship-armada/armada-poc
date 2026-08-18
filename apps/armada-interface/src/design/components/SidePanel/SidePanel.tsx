// ABOUTME: SidePanel — portaled right-edge slide-in dialog with a dimming scrim, scroll lock, and Escape-to-close.
// ABOUTME: Ported from the armada-app mockup; used by the wallet menu. Header (title + close) is optional.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import styles from './SidePanel.module.css'

const EXIT_MS = 240

export interface SidePanelProps {
  open: boolean
  onClose: () => void
  title?: string
  ariaLabel?: string
  panelClassName?: string
  children: ReactNode
}

export function SidePanel({ open, onClose, title, ariaLabel, panelClassName, children }: SidePanelProps) {
  const titleId = useId()
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useBodyScrollLock(open || exiting)
  useEscapeKey(onClose, mounted && !exiting)

  // Mount on open; on close, play the exit animation before unmounting.
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

  if (!mounted) return null

  const scrimClassName = [styles.scrim, exiting && styles.scrimExit].filter(Boolean).join(' ')
  const panelClassNameResolved = [styles.panel, panelClassName, exiting && styles.panelExit]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <div className={scrimClassName} role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        className={panelClassNameResolved}
        onClick={(event) => event.stopPropagation()}
      >
        {title ? (
          <div className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <button type="button" className={styles.closeButton} aria-label="Close" onClick={onClose}>
              <XMarkIcon width={20} height={20} strokeWidth={2} />
            </button>
          </div>
        ) : null}

        <div className={styles.body}>{children}</div>
      </div>
    </div>,
    document.body,
  )
}
