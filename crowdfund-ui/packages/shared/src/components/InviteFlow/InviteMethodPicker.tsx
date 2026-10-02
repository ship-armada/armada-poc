// ABOUTME: Method picker for empty invite slots — desktop anchored menu; mobile bottom sheet.
// ABOUTME: Exit animation + visual-viewport sticky bottom so chrome show/hide doesn't drift.

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InviteMethod } from '../../lib/inviteUx'
import {
  useIsMobileLayout,
  visualViewportBottomInset,
} from '../../hooks/useIsMobileLayout'
import { INVITE_SHEET_EXIT_MS } from './inviteSheetMotion'
import styles from './InviteMethodPicker.module.css'

const OPTIONS: {
  method: InviteMethod
  label: string
  hint: string
}[] = [
  {
    method: 'onchain',
    label: 'Whitelist new address',
    hint: 'Invite onchain — requires gas',
  },
  {
    method: 'link',
    label: 'Share link',
    hint: 'Create a redeemable invite link',
  },
]

export interface InviteMethodPickerProps {
  open: boolean
  /** Anchor for desktop menu positioning (the Invite button). */
  anchorEl: HTMLElement | null
  slotId: number
  /** Optional heading / aria label override (e.g. hop-based invite). */
  title?: string
  onSelect: (method: InviteMethod) => void
  onClose: () => void
}

export function InviteMethodPicker({
  open,
  anchorEl,
  slotId,
  title,
  onSelect,
  onClose,
}: InviteMethodPickerProps) {
  const isMobile = useIsMobileLayout()
  const titleId = useId()
  const menuRef = useRef<HTMLUListElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  const heading = title ?? `Whitelist a friend — slot ${slotId}`
  const menuLabel = title ?? `Whitelist options for slot ${slotId}`

  useEffect(() => {
    if (open) {
      setMounted(true)
      setExiting(false)
      return
    }
    if (!mounted) return
    if (!isMobile) {
      setMounted(false)
      setExiting(false)
      return
    }
    setExiting(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setExiting(false)
    }, INVITE_SHEET_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted, isMobile])

  useLayoutEffect(() => {
    if (!open || isMobile || !anchorEl) {
      setMenuPos(null)
      return
    }
    const rect = anchorEl.getBoundingClientRect()
    const menuWidth = 260
    const gap = 6
    const estimatedHeight = 140
    let left = rect.right - menuWidth
    left = Math.max(12, Math.min(left, window.innerWidth - menuWidth - 12))
    // Prefer above the Invite button (card sits near the bottom of the view).
    let top = rect.top - gap - estimatedHeight
    if (top < 12) {
      top = Math.min(rect.bottom + gap, window.innerHeight - estimatedHeight - 12)
      top = Math.max(12, top)
    }
    setMenuPos({ top, left })
  }, [open, isMobile, anchorEl])

  // Keep sheet + scrim glued to the *visible* bottom — layout `bottom: 0` drifts
  // when mobile browser chrome shows/hides.
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
    if (!open || exiting) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (anchorEl?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      if (sheetRef.current?.contains(target)) return
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, exiting, anchorEl, onClose])

  useEffect(() => {
    if (!open || exiting) return
    const root = isMobile ? sheetRef.current : menuRef.current
    const first = root?.querySelector<HTMLElement>('button[role="menuitem"], button')
    first?.focus()
  }, [open, exiting, isMobile])

  useEffect(() => {
    if (!mounted || !isMobile) return
    const html = document.documentElement
    const body = document.body
    const scrollY = window.scrollY
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyWidth: body.style.width,
    }
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'
    return () => {
      html.style.overflow = prev.htmlOverflow
      body.style.overflow = prev.bodyOverflow
      body.style.position = prev.bodyPosition
      body.style.top = prev.bodyTop
      body.style.width = prev.bodyWidth
      window.scrollTo(0, scrollY)
    }
  }, [mounted, isMobile])

  if (!mounted || typeof document === 'undefined') return null

  const optionButtons = OPTIONS.map((opt) => (
    <li key={opt.method} role="none">
      <button
        type="button"
        role="menuitem"
        className={isMobile ? styles.sheetItem : styles.menuItem}
        onClick={() => onSelect(opt.method)}
        disabled={exiting}
      >
        <span className={styles.menuItemLabel}>{opt.label}</span>
        <span className={styles.menuItemHint}>{opt.hint}</span>
      </button>
    </li>
  ))

  if (isMobile) {
    return createPortal(
      <>
        <div
          ref={scrimRef}
          className={[styles.sheetScrim, exiting ? styles.sheetScrimExit : undefined]
            .filter(Boolean)
            .join(' ')}
          role="presentation"
          onClick={exiting ? undefined : onClose}
        />
        <div
          ref={sheetRef}
          className={[styles.sheet, exiting ? styles.sheetExit : undefined]
            .filter(Boolean)
            .join(' ')}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div className={styles.sheetHandle} aria-hidden />
          <h2 id={titleId} className={styles.sheetTitle}>
            {heading}
          </h2>
          <ul className={styles.sheetList} role="menu">
            {optionButtons}
          </ul>
        </div>
      </>,
      document.body,
    )
  }

  if (!menuPos || !open) return null

  return createPortal(
    <ul
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label={menuLabel}
      style={{ top: menuPos.top, left: menuPos.left }}
    >
      {optionButtons}
    </ul>,
    document.body,
  )
}
