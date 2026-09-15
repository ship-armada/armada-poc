// ABOUTME: Single navigation pill — default, active, and disabled states with click handler.
// ABOUTME: Ported from the armada-crowdfund mockup; `disabled` added for gated Claim tab.

import styles from './NavItem.module.css'

export interface NavItemProps {
  label: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  className?: string
}

export function NavItem({
  label,
  active = false,
  disabled = false,
  onClick,
  className,
}: NavItemProps) {
  return (
    <button
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
      {label}
    </button>
  )
}
