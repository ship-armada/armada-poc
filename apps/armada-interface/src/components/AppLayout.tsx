// ABOUTME: App-wide layout — fixed @armada/ui-style header with our routes, body padding to clear the inset header.
// ABOUTME: Header is local to this app (not the crowdfund-shared AppHeader) — different nav, a network badge, custom right-side chrome.

import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArmadaLogo, NavBar, type NavBarItem } from '@armada/ui'
import { WalletConnector } from './WalletConnector'
import { SyncBanner } from './sync'
import { HistoryRecoveryBanner } from './history'
import { getNetworkMode } from '@/config/network'
import styles from './AppLayout.module.css'

// Persistent network badge (P1-22) so a user can never mistake a testnet build for mainnet. Sepolia
// → "Testnet"; local → "Local" (harmless, helps devs tell builds apart). Styled as a flat pill
// matching the wallet pill, with a brand-lavender dot.
const NETWORK_BADGE_LABEL = getNetworkMode() === 'sepolia' ? 'Testnet' : 'Local'

// Debug is intentionally NOT in the primary nav for the public demo (P2/WS4.6) — it exposes
// contract addresses + per-chain balances + (local-only) faucet tools. The `/debug` route stays
// registered in main.tsx and reachable by direct URL for devs.
const NAV: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'Dashboard', path: '/' },
  { label: 'History', path: '/history' },
  { label: 'Settings', path: '/settings' },
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
        className="fixed inset-x-6 top-2 z-40 flex h-auto items-start justify-between"
      >
        <Link to="/" aria-label="Home" className="flex shrink-0 items-center gap-2.5 text-white">
          <ArmadaLogo variant="mono" />
        </Link>

        <nav aria-label="Primary" className="absolute left-1/2 hidden -translate-x-1/2 items-center sm:flex">
          <NavBar items={navItems} className={styles.navBar} />
        </nav>

        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <span className={styles.networkBadge} role="status">
            {NETWORK_BADGE_LABEL}
          </span>
          {/* V2 Phase 3a: merged pill — the 0zk shielded identity now lives inside
              `WalletConnector`'s `WalletPillMenu` dropdown (via the `extraSection` prop), so
              the separate `ShieldedAddressPill` previously sat here is gone. */}
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
          {/* The dashboard renders its own prominent full-area SyncGate, so the thin strip would
              be redundant there — show it only on the other routes (History/Settings). */}
          {location.pathname !== '/' && <SyncBanner />}
          <HistoryRecoveryBanner />
        </div>
        {children}
      </main>
    </div>
  )
}
