// ABOUTME: Mobile bottom sheet wrapper for InviteActionScreen (form → confirmation).
// ABOUTME: Portals over the hop list; focuses the sheet (not the address input).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  useIsMobileLayout,
  visualViewportBottomInset,
} from '../../hooks/useIsMobileLayout'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'
import { INVITE_SHEET_EXIT_MS } from './inviteSheetMotion'
import styles from './InviteActionSheet.module.css'

export interface InviteActionSheetProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** Accessible name for the dialog. */
  ariaLabel: string
  /** When false, a backdrop tap / Escape does nothing — e.g. while an invite is
   *  being sent, when the screen's own Cancel is disabled too. Default true. */
  dismissible?: boolean
}

export function InviteActionSheet({
  open,
  onClose,
  children,
  ariaLabel,
  dismissible = true,
}: InviteActionSheetProps) {
  const isMobile = useIsMobileLayout()
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
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
    }, INVITE_SHEET_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  useLayoutEffect(() => {
    if (!mounted || !isMobile) return

    const sync = () => {
      const bottom = `${visualViewportBottomInset()}px`
      const top = `${window.visualViewport?.offsetTop ?? 0}px`
      if (sheetRef.current) sheetRef.current.style.bottom = bottom
      if (scrimRef.current) {
        scrimRef.current.style.top = top
        scrimRef.current.style.bottom = bottom
      }
    }

    sync()
    const vv = window.visualViewport
    vv?.addEventListener('resize', sync)
    vv?.addEventListener('scroll', sync)
    window.addEventListener('resize', sync)
    return () => {
      vv?.removeEventListener('resize', sync)
      vv?.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
  }, [mounted, isMobile])

  useEffect(() => {
    if (!open || exiting || !isMobile || !dismissible) return

    // Capture phase so this top layer sees Escape before a modal underneath;
    // `preventDefault` tells that modal it was handled.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, exiting, isMobile, dismissible, onClose])

  useBodyScrollLock(mounted && isMobile)

  useEffect(() => {
    if (!open || exiting || !isMobile) return
    // Focus the sheet itself — never auto-focus the address input (opens keyboard).
    sheetRef.current?.focus({ preventScroll: true })
  }, [open, exiting, isMobile])

  if (!mounted || !isMobile || typeof document === 'undefined') return null

  return createPortal(
    <>
      <div
        ref={scrimRef}
        className={[styles.scrim, exiting ? styles.scrimExit : undefined]
          .filter(Boolean)
          .join(' ')}
        role="presentation"
        onClick={exiting || !dismissible ? undefined : onClose}
      />
      <div
        ref={sheetRef}
        className={[styles.sheet, exiting ? styles.sheetExit : undefined]
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
      >
        <div className={styles.handle} aria-hidden />
        <div className={styles.body}>{children}</div>
      </div>
    </>,
    document.body,
  )
}
