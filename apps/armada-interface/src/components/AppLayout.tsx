// ABOUTME: App-wide layout — fixed @armada/ui-style header with our routes, body padding to clear the inset header.
// ABOUTME: Header is local to this app (not the crowdfund-shared AppHeader) — different nav, a network badge, custom right-side chrome.

import { type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useSetAtom } from 'jotai'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { ArmadaLogo } from '@/design'
import { WalletConnector } from './WalletConnector'
import { AppFooter } from './AppFooter/AppFooter'
import { SyncBanner } from './sync'
import { HistoryRecoveryBanner } from './history'
import { openModalAtom } from '@/state/ui'
import { getNetworkMode } from '@/config/network'
import styles from './AppLayout.module.css'

// Persistent network badge (P1-22) so a user can never mistake a testnet build for mainnet. Sepolia
// → "Testnet"; local → "Local" (harmless, helps devs tell builds apart). Styled as a flat pill
// matching the wallet pill, with a brand-lavender dot.
const NETWORK_BADGE_LABEL = getNetworkMode() === 'sepolia' ? 'Testnet' : 'Local'

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const setOpenModal = useSetAtom(openModalAtom)

  return (
    <div className="flex min-h-screen flex-col text-foreground">
      <header
        className="fixed inset-x-6 top-5 z-40 flex h-auto items-center justify-between"
      >
        <Link to="/" aria-label="Home" className="flex shrink-0 items-center gap-2.5 text-white">
          <ArmadaLogo variant="mono" />
        </Link>

        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <span className={styles.networkBadge} role="status">
            {NETWORK_BADGE_LABEL}
          </span>
          {/* Settings moved off the nav into a gear here (left of the wallet pill), opening the
              Settings overlay over the dashboard — the standalone /settings route is gone. */}
          <button
            type="button"
            className={styles.gearButton}
            onClick={() => setOpenModal('settings')}
            aria-label="Settings"
          >
            <Cog6ToothIcon className={styles.gearIcon} aria-hidden />
          </button>
          {/* V2 Phase 3a: merged pill — the 0zk shielded identity now lives inside
              `WalletConnector`'s `WalletPillMenu` dropdown (via the `extraSection` prop), so
              the separate `ShieldedAddressPill` previously sat here is gone. */}
          <WalletConnector />
        </div>
      </header>

      {/* Inline paddingTop instead of a Tailwind utility — `pt-28` was getting eaten somewhere
          in the cascade (either not generated, or overridden by global.css's universal-selector
          reset). Inline style has the highest specificity short of !important and bypasses
          generation issues entirely. 6.5rem seats the content below the fixed header, matching the
          mockup's header→card gap. */}
      <main
        className="relative flex flex-1 flex-col items-center justify-start"
        style={{ paddingTop: '6.5rem' }}
      >
        {/* Status strips are overlaid (absolute) rather than in flow, so a transient banner
            appearing/disappearing never reflows the page content beneath it. pointer-events are
            off on the wrapper and back on for the strips, so clicks pass through empty space. */}
        <div className={styles.bannerOverlay}>
          {/* The dashboard renders its own prominent full-area SyncGate, so the thin strip would
              be redundant there — show it only on the other routes (History/Settings). */}
          {location.pathname !== '/' && <SyncBanner />}
          <HistoryRecoveryBanner />
        </div>
        {children}
      </main>
      <AppFooter />
    </div>
  )
}
