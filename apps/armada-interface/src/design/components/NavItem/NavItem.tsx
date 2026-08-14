// ABOUTME: Single navigation pill — default and active states with click handler.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup.

import styles from './NavItem.module.css'

export interface NavItemProps {
  label: string
  active?: boolean
  onClick?: () => void
  className?: string
}

export function NavItem({ label, active = false, onClick, className }: NavItemProps) {
  return (
    <button
      className={[styles.navItem, active ? styles.active : '', className].filter(Boolean).join(' ')}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </button>
  )
}
