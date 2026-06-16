// ABOUTME: Committer full-screen mobile menu — gradient panel with RainbowKit wallet block, nav, and Participate/Claim.
// ABOUTME: Mobile equivalent of the designer's HeaderMobileMenu, hosted inside AppHeader's full-screen Sheet.

import { useEffect, useRef, useState } from 'react'
import {
  ArrowRightOnRectangleIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  WalletIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { WalletMetamask, WalletPhantom, WalletWalletConnect } from '@web3icons/react'
import { useAccount, useDisconnect } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { ArmadaLogo, Button as ArmadaButton } from '@armada/ui'
import { Participate, fleetPng, fleetMp4 } from '@armada/crowdfund-shared'
import type { Page } from '@/appNav'
import styles from './CommitterMobileMenu.module.css'

const ACTION_ICON_PX = 20
const WALLET_ICON_PX = 48
const PROJECT_URL = 'https://armada.wtf'

/** Map a wagmi connector id to the designer's `@web3icons` provider switch. */
function detectWalletProvider(connectorId?: string): string | undefined {
  if (!connectorId) return undefined
  const id = connectorId.toLowerCase()
  if (id.includes('metamask')) return 'metamask'
  if (id.includes('phantom')) return 'phantom'
  if (id.includes('walletconnect')) return 'walletconnect'
  return undefined
}

function WalletProviderIcon({ provider, size = WALLET_ICON_PX }: { provider?: string; size?: number }) {
  switch (provider) {
    case 'metamask':
      return <WalletMetamask size={size} aria-hidden />
    case 'phantom':
      return <WalletPhantom size={size} aria-hidden />
    case 'walletconnect':
      return <WalletWalletConnect size={size} aria-hidden />
    default:
      return <WalletIcon width={size} height={size} aria-hidden />
  }
}

/** Mockup convention is 6 chars before the ellipsis ("0x1234...abcd"). */
function truncate6(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export interface CommitterMobileMenuProps {
  /** Close the host Sheet (also called after every nav/action). */
  onClose: () => void
  current: Page
  onNavigate: (page: Page) => void
  onParticipate: () => void
  onClaim: () => void
  /** Wallet has a claimable ARM/refund position — swaps Participate for Claim. */
  claimAvailable: boolean
  /** Commit window is open — gates the Participate CTA (mirrors header chrome). */
  participationEnabled: boolean
  /** Connected wallet USDC balance (6 decimals). */
  usdcBalance: bigint
}

export function CommitterMobileMenu({
  onClose,
  current,
  onNavigate,
  onParticipate,
  onClaim,
  claimAvailable,
  participationEnabled,
  usdcBalance,
}: CommitterMobileMenuProps) {
  const { connector } = useAccount()
  const { disconnect } = useDisconnect()
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const navigate = (page: Page) => {
    onNavigate(page)
    onClose()
  }

  const navItemClass = (active: boolean) =>
    [styles.navItem, active && styles.navItemActive].filter(Boolean).join(' ')

  return (
    <div className={styles.panel}>
      <div className={styles.topBar}>
        <ArmadaLogo variant="mark" markTone="white" className={styles.logoMark} />
        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close menu">
          <XMarkIcon width={ACTION_ICON_PX} height={ACTION_ICON_PX} aria-hidden />
        </button>
      </div>

      <div className={styles.scroll}>
        <ConnectButton.Custom>
          {({ account, chain, mounted, authenticationStatus, openConnectModal, openChainModal }) => {
            const isReady = mounted && authenticationStatus !== 'loading'
            const isConnected =
              isReady &&
              account &&
              chain &&
              (!authenticationStatus || authenticationStatus === 'authenticated')

            if (!isConnected) {
              return (
                <div
                  className={[styles.walletBlock, styles.walletBlockDisconnected, styles.sectionSpacing]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <ArmadaButton
                    variant="primary"
                    size="lg"
                    label="Connect wallet"
                    showIcon={false}
                    className={styles.connectWalletBtn}
                    onClick={() => {
                      openConnectModal()
                      onClose()
                    }}
                  />
                </div>
              )
            }

            if (chain.unsupported) {
              return (
                <div
                  className={[styles.walletBlock, styles.walletBlockDisconnected, styles.sectionSpacing]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <ArmadaButton
                    variant="primary"
                    size="lg"
                    label="Wrong network"
                    showIcon={false}
                    className={styles.connectWalletBtn}
                    onClick={() => {
                      openChainModal()
                      onClose()
                    }}
                  />
                </div>
              )
            }

            const provider = detectWalletProvider(connector?.id)
            const displayAddress = account.displayName.startsWith('0x')
              ? truncate6(account.address)
              : account.displayName
            const balanceLabel = `${Number(usdcBalance / 1_000_000n).toLocaleString('en-US')} USDC`

            const handleCopy = async () => {
              try {
                await navigator.clipboard.writeText(account.address)
                setCopied(true)
                if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
                copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
              } catch {
                setCopied(false)
              }
            }

            return (
              <div className={[styles.walletBlock, styles.sectionSpacing].join(' ')}>
                <span className={styles.walletIcon}>
                  <WalletProviderIcon provider={provider} />
                </span>
                <p className={styles.walletAddress}>{displayAddress}</p>
                <p className={styles.walletBalance}>{balanceLabel}</p>
                <div className={styles.walletActions}>
                  <button
                    type="button"
                    className={[styles.roundActionBtn, copied && styles.roundActionBtnCopied]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => void handleCopy()}
                    aria-label={copied ? 'Copied' : 'Copy address'}
                  >
                    {copied ? (
                      <CheckIcon width={ACTION_ICON_PX} height={ACTION_ICON_PX} aria-hidden />
                    ) : (
                      <ClipboardDocumentIcon width={ACTION_ICON_PX} height={ACTION_ICON_PX} aria-hidden />
                    )}
                  </button>
                  <button
                    type="button"
                    className={styles.roundActionBtn}
                    onClick={() => {
                      disconnect()
                      onClose()
                    }}
                    aria-label="Disconnect"
                  >
                    <ArrowRightOnRectangleIcon width={ACTION_ICON_PX} height={ACTION_ICON_PX} aria-hidden />
                  </button>
                </div>
              </div>
            )
          }}
        </ConnectButton.Custom>

        <hr className={styles.separator} aria-hidden />

        <nav className={[styles.nav, styles.sectionSpacing].join(' ')} aria-label="Main">
          <button
            type="button"
            className={styles.navItem}
            onClick={() => {
              window.open(PROJECT_URL, '_blank', 'noopener,noreferrer')
              onClose()
            }}
          >
            The project
          </button>
          <button
            type="button"
            className={navItemClass(current === 'network')}
            aria-current={current === 'network' ? 'page' : undefined}
            onClick={() => navigate('network')}
          >
            Crowdfund
          </button>
          <button
            type="button"
            className={navItemClass(current === 'my-position')}
            aria-current={current === 'my-position' ? 'page' : undefined}
            onClick={() => navigate('my-position')}
          >
            My Position
          </button>
        </nav>

        <hr className={styles.separator} aria-hidden />

        {claimAvailable ? (
          <ArmadaButton
            variant="ghost"
            size="md"
            label="Claim"
            showIcon={false}
            className={styles.claimBtn}
            onClick={() => {
              onClaim()
              onClose()
            }}
          />
        ) : participationEnabled ? (
          <Participate
            className={styles.participateCard}
            imageSrc={fleetPng}
            videoSrc={fleetMp4}
            onCtaClick={() => {
              onParticipate()
              onClose()
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
