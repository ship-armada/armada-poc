// ABOUTME: App header with logo, nav, wallet pill (or Connect wallet CTA), and gradient Participate CTA; auto-hides on scroll.
// ABOUTME: Ported from the mockup; ArmadaLogo hoisted to a sibling primitive for reuse, NavBarItem type-import split for verbatimModuleSyntax consumers.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArmadaLogo } from '../ArmadaLogo'
import { NavBar } from '../NavBar'
import type { NavBarItem } from '../NavBar'
import { Button } from '../Button'
import { WalletPillMenu } from './WalletPillMenu'
import styles from './Header.module.css'

// Minimal `import.meta.env.BASE_URL` augmentation co-located with the only
// file in @armada/ui that reads it. Travels with the file so transitive
// typechecks from any consumer (crowdfund-shared, committer, observer, etc.)
// pick it up regardless of whether they include Vite's client types.
declare global {
  // Modifiers chosen to match Vite's official `client.d.ts` so consumers that
  // include `vite/client` types don't trigger "all declarations must have
  // identical modifiers" errors via merging: `BASE_URL` is non-readonly on
  // `ImportMetaEnv`, but `env` is `readonly` on `ImportMeta`.
  interface ImportMetaEnv {
    BASE_URL: string
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export interface HeaderProps {
  activeNav?: 'project' | 'crowdfund' | 'myposition'
  walletAddress?: string
  /** Full address for clipboard copy in the wallet menu. */
  walletCopyAddress?: string
  walletProvider?: string
  usdcBalance?: number
  onDisconnect?: () => void
  /** When false, show Connect wallet pill and hide My position. Defaults to true. */
  walletConnected?: boolean
  claimAvailable?: boolean
  onMyPosition?: () => void
  onCrowdfund?: () => void
  onClaim?: () => void
  onParticipate?: () => void
  onConnectWallet?: () => void
  className?: string
  /** Hide header when scrolling down; show when scrolling up (near top always visible). */
  autoHideOnScroll?: boolean
}

const SCROLL_DELTA = 6

const MY_POSITION_PATH = `${import.meta.env.BASE_URL}?view=myposition`
const CROWDFUND_PATH = `${import.meta.env.BASE_URL}`

export function Header({
  activeNav = 'crowdfund',
  walletAddress = '0x6545...54534',
  walletCopyAddress,
  walletProvider = 'metamask',
  usdcBalance = 0,
  onDisconnect,
  walletConnected = true,
  claimAvailable = false,
  onMyPosition,
  onCrowdfund,
  onClaim,
  onParticipate,
  onConnectWallet,
  className,
  autoHideOnScroll = true,
}: HeaderProps) {
  const [concealed, setConcealed] = useState(false)
  const lastY = useRef(0)

  const handleCrowdfund = () => {
    if (onCrowdfund) {
      onCrowdfund()
      return
    }
    if (activeNav !== 'crowdfund') {
      window.location.assign(CROWDFUND_PATH)
    }
  }

  const handleMyPosition = () => {
    if (onMyPosition) {
      onMyPosition()
      return
    }
    if (activeNav !== 'myposition') {
      window.location.assign(MY_POSITION_PATH)
    }
  }

  const navItems = useMemo<NavBarItem[]>(
    () => [
      { label: 'The project', active: activeNav === 'project' },
      {
        label: 'Crowdfund',
        active: activeNav === 'crowdfund',
        onClick: activeNav !== 'crowdfund' ? handleCrowdfund : undefined,
      },
    ],
    [activeNav, onCrowdfund],
  )

  useEffect(() => {
    if (!autoHideOnScroll) {
      setConcealed(false)
      return
    }

    lastY.current = window.scrollY

    const onScroll = () => {
      const y = window.scrollY
      if (y < 48) {
        setConcealed(false)
      } else if (y > lastY.current + SCROLL_DELTA) {
        setConcealed(true)
      } else if (y < lastY.current - SCROLL_DELTA) {
        setConcealed(false)
      }
      lastY.current = y
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [autoHideOnScroll])

  return (
    <header
      className={[styles.header, concealed && styles.concealed, className].filter(Boolean).join(' ')}
    >
      <div className={styles.left}>
        <div className={styles.logo}>
          <ArmadaLogo />
        </div>
        <NavBar items={navItems} />
      </div>

      <div className={styles.actions}>
        {walletConnected && (
          <Button
            variant="ghost"
            size="md"
            label="My position"
            showIcon={false}
            onClick={handleMyPosition}
            className={activeNav === 'myposition' ? styles.myPositionActive : undefined}
          />
        )}
        {claimAvailable && (
          <Button variant="ghost" size="md" label="Claim" showIcon={false} onClick={onClaim} />
        )}
        {walletConnected ? (
          <WalletPillMenu
            displayAddress={walletAddress}
            copyAddress={walletCopyAddress ?? walletAddress}
            walletProvider={walletProvider}
            usdcBalance={usdcBalance}
            onDisconnect={onDisconnect}
          />
        ) : (
          <Button
            variant="secondary"
            size="md"
            label="Connect wallet"
            showIcon={false}
            onClick={onConnectWallet}
          />
        )}
        {!claimAvailable && (
          <Button
            variant="gradient"
            size="md"
            label="Participate"
            showIcon
            icon="arrow-right-micro"
            onClick={onParticipate}
          />
        )}
      </div>
    </header>
  )
}
