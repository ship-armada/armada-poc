// ABOUTME: Horizontal navigation strip composed of NavItem buttons with a sliding active thumb.
// ABOUTME: Ported from the armada-crowdfund demo; measures the active item to animate the lavender pill.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavItem } from '../NavItem'
import styles from './NavBar.module.css'

export interface NavBarItem {
  label: string
  active?: boolean
  disabled?: boolean
  accent?: 'brand'
  onClick?: () => void
}
export interface NavBarProps { items: NavBarItem[]; className?: string }

type ThumbRect = { left: number; width: number; visible: boolean }

export function NavBar({ items, className }: NavBarProps) {
  const navRef = useRef<HTMLElement>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [thumb, setThumb] = useState<ThumbRect>({ left: 0, width: 0, visible: false })

  const activeLabel = items.find((item) => item.active)?.label

  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav || !activeLabel) {
      setThumb((prev) => (prev.visible ? { ...prev, visible: false } : prev))
      return
    }

    const item = itemRefs.current.get(activeLabel)
    if (!item) return

    const navRect = nav.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    const next = {
      left: itemRect.left - navRect.left,
      width: itemRect.width,
      visible: true,
    }
    setThumb((prev) =>
      prev.left === next.left && prev.width === next.width && prev.visible === next.visible
        ? prev
        : next,
    )
  }, [activeLabel, items])

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return

    const sync = () => {
      if (!activeLabel) return
      const item = itemRefs.current.get(activeLabel)
      if (!item) return
      const navRect = nav.getBoundingClientRect()
      const itemRect = item.getBoundingClientRect()
      setThumb({
        left: itemRect.left - navRect.left,
        width: itemRect.width,
        visible: true,
      })
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null
    ro?.observe(nav)
    window.addEventListener('resize', sync)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [activeLabel])

  return (
    <nav
      ref={navRef}
      className={[styles.navBar, className].filter(Boolean).join(' ')}
    >
      <span
        className={[styles.thumb, thumb.visible && styles.thumbVisible].filter(Boolean).join(' ')}
        style={{
          width: thumb.width,
          transform: `translateX(${thumb.left}px)`,
        }}
        aria-hidden
      />
      {items.map((item) => (
        <NavItem
          key={item.label}
          ref={(node) => {
            if (node) itemRefs.current.set(item.label, node)
            else itemRefs.current.delete(item.label)
          }}
          label={item.label}
          active={item.active}
          disabled={item.disabled}
          accent={item.accent}
          onClick={item.onClick}
        />
      ))}
    </nav>
  )
}
