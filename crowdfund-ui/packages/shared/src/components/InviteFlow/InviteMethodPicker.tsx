// ABOUTME: Method picker for empty invite slots — desktop anchored menu; mobile bottom sheet.

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InviteMethod } from '../../lib/inviteUx'
import { MOBILE_LAYOUT_MAX_WIDTH_PX } from '../../lib/viewportBreakpoints'
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
  anchorEl: HTMLElement | null
  slotId: number
  onSelect: (method: InviteMethod) => void
  onClose: () => void
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH_PX}px)`).matches
      : false,
  )
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH_PX}px)`)
    const sync = () => setMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return mobile
}

export function InviteMethodPicker({
  open,
  anchorEl,
  slotId,
  onSelect,
  onClose,
}: InviteMethodPickerProps) {
  const isMobile = useIsMobile()
  const titleId = useId()
  const menuRef = useRef<HTMLUListElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

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

  useEffect(() => {
    if (!open) return

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
  }, [open, anchorEl, onClose])

  useEffect(() => {
    if (!open) return
    const root = isMobile ? sheetRef.current : menuRef.current
    const first = root?.querySelector<HTMLElement>('button[role="menuitem"], button')
    first?.focus()
  }, [open, isMobile])

  useEffect(() => {
    if (!open || !isMobile) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open, isMobile])

  if (!open || typeof document === 'undefined') return null

  const optionButtons = OPTIONS.map((opt) => (
    <li key={opt.method} role="none">
      <button
        type="button"
        role="menuitem"
        className={isMobile ? styles.sheetItem : styles.menuItem}
        onClick={() => onSelect(opt.method)}
      >
        <span className={styles.menuItemLabel}>{opt.label}</span>
        <span className={styles.menuItemHint}>{opt.hint}</span>
      </button>
    </li>
  ))

  if (isMobile) {
    return createPortal(
      <>
        <div className={styles.sheetScrim} role="presentation" onClick={onClose} />
        <div
          ref={sheetRef}
          className={styles.sheet}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div className={styles.sheetHandle} aria-hidden />
          <h2 id={titleId} className={styles.sheetTitle}>
            Whitelist a friend — slot {slotId}
          </h2>
          <ul className={styles.sheetList} role="menu">
            {optionButtons}
          </ul>
        </div>
      </>,
      document.body,
    )
  }

  if (!menuPos) return null

  return createPortal(
    <ul
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label={`Whitelist options for slot ${slotId}`}
      style={{ top: menuPos.top, left: menuPos.left }}
    >
      {optionButtons}
    </ul>,
    document.body,
  )
}
