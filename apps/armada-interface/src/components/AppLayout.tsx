// ABOUTME: App-wide layout — fixed @armada/ui-style header with our routes, body padding to clear the inset header.
// ABOUTME: Header is local to this app (not the crowdfund-shared AppHeader) — different nav, no network badge, custom right-side chrome.

import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArmadaLogo, NavBar, type NavBarItem } from '@armada/ui'
import { WalletConnector } from './WalletConnector'
import { ShieldedAddressPill } from './ShieldedAddressPill'
import { SyncBanner } from './sync'
import styles from './AppLayout.module.css'

const NAV: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'Dashboard', path: '/' },
  { label: 'History', path: '/history' },
  { label: 'Settings', path: '/settings' },
  { label: 'Debug', path: '/debug' },
]

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [_unused] = useState(false) // reserved for mobile sheet open state

  const navItems: NavBarItem[] = NAV.map(item => ({
    label: item.label,
    active: location.pathname === item.path,
    onClick: () => navigate(item.path),
  }))

  return (
    <div className="flex min-h-screen flex-col text-foreground">
      <header
        className="fixed inset-x-6 top-2 z-40 flex h-14 items-center justify-between"
      >
        <Link to="/" aria-label="Home" className="flex shrink-0 items-center gap-2.5 text-white">
          <ArmadaLogo variant="mono" />
        </Link>

        <nav aria-label="Primary" className="absolute left-1/2 hidden -translate-x-1/2 items-center sm:flex">
          <NavBar items={navItems} className={styles.navBar} />
        </nav>

        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <ShieldedAddressPill />
          <WalletConnector />
        </div>
      </header>

      {/* Inline paddingTop instead of a Tailwind utility — `pt-28` was getting eaten somewhere
          in the cascade (either not generated, or overridden by global.css's universal-selector
          reset). Inline style has the highest specificity short of !important and bypasses
          generation issues entirely. 80px = 64px header bottom (top-2 + h-14) + 16px breathing. */}
      <main
        className="flex flex-1 flex-col items-center justify-center"
        style={{ paddingTop: '5rem' }}
      >
        <div className="w-full px-6">
          <SyncBanner />
        </div>
        {children}
      </main>
    </div>
  )
}
