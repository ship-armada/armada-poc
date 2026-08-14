// ABOUTME: Horizontal navigation strip composed of NavItem buttons.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup.

import { NavItem } from '../NavItem'
import styles from './NavBar.module.css'

export interface NavBarItem { label: string; active?: boolean; onClick?: () => void }
export interface NavBarProps { items: NavBarItem[]; className?: string }

export function NavBar({ items, className }: NavBarProps) {
  return (
    <nav className={[styles.navBar, className].filter(Boolean).join(' ')}>
      {items.map(item => (
        <NavItem key={item.label} label={item.label} active={item.active} onClick={item.onClick} />
      ))}
    </nav>
  )
}
