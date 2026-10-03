// ABOUTME: Single navigation pill — default, active, disabled; optional brand-gradient label (Claim).
// ABOUTME: Active fill is drawn by NavBar's sliding thumb; forwards ref so NavBar can measure.

import { forwardRef } from 'react'
import styles from './NavItem.module.css'

export interface NavItemProps {
  label: string
  active?: boolean
  disabled?: boolean
  /** Brand gradient label (e.g. Claim when available). */
  accent?: 'brand'
  onClick?: () => void
  className?: string
}

export const NavItem = forwardRef<HTMLButtonElement, NavItemProps>(function NavItem(
  {
    label,
    active = false,
    disabled = false,
    accent,
    onClick,
    className,
  },
  ref,
) {
  const brandLabel = accent === 'brand' && !disabled

  return (
    <button
      ref={ref}
      type="button"
      className={[
        styles.navItem,
        active && styles.active,
        disabled && styles.disabled,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled || undefined}
    >
      <span className={brandLabel ? styles.brandLabel : undefined}>{label}</span>
    </button>
  )
})
