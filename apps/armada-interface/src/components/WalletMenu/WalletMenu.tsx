// ABOUTME: Connected-wallet control — a pill trigger (provider icon + address) that opens a right-edge SidePanel with the EVM wallet identity, labeled actions (hide/copy/explorer/disconnect), USDC balance, and a Shield CTA.
// ABOUTME: Matches the mockup's polished wallet panel; the pill fades out as the panel opens and back in as it closes. Balance-hide is shared app-wide via balanceHiddenAtom (owned by the parent).

import { useEffect, useRef, useState } from 'react'
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  EyeIcon,
  EyeSlashIcon,
  PlusIcon,
  PowerIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { IconButton, SidePanel, SIDE_PANEL_EXIT_MS } from '@/design'
import { WalletProviderIcon } from '@/components/ui/WalletProviderIcon'
import { chainIconForChainId } from '@/components/ui/chainIcons'
import { BalanceActionButton } from '@/components/dashboard/BalanceActionButton'
import { SendButton } from '@/components/dashboard/SendButton'
import { BalanceScrambleValue } from '@/components/dashboard/BalanceScrambleValue'
import { formatUsdcAmount } from '@/components/dashboard/dashboardFormat'
import styles from './WalletMenu.module.css'

const HERO_ICON_PX = 56
const USDC_GLYPH_PX = 40
const USDC_GLYPH_SIZE = Math.round((USDC_GLYPH_PX * 24) / 18)
const USDC_OVERLAY_ICON_PX = 16

/** Pill fade duration — the pill fades out before the panel opens (and back in after it closes). */
const PILL_FADE_MS = 180

function fadeDelayMs(): number {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return PILL_FADE_MS
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : PILL_FADE_MS
}

export interface WalletMenuProps {
  /** Truncated EVM address — shown on the pill + panel hero. */
  displayAddress: string
  /** Full EVM address — used for copy. */
  fullAddress: string
  /** Connected wallet provider name (wagmi connector) — drives the brand glyph. */
  walletProvider?: string
  /** Connected chain id — drives the USDC-row network overlay glyph. */
  chainId: number
  /** Connected EVM wallet USDC balance (plain number). */
  usdcBalance: number
  /** Connected chain name — shown as the network tag + USDC row subtitle. */
  networkLabel: string
  /** Address explorer URL; the "Explorer" action is disabled when absent (e.g. local Anvil). */
  explorerUrl?: string
  /** Shared app-wide balance visibility (from balanceHiddenAtom). */
  balanceHidden: boolean
  onBalanceHiddenChange: (hidden: boolean) => void
  onDisconnect: () => void
  onDeposit: () => void
  /** Pill trigger class passthrough (offwhite fill from WalletConnector). */
  triggerClassName?: string
}

export function WalletMenu({
  displayAddress,
  fullAddress,
  walletProvider,
  chainId,
  usdcBalance,
  networkLabel,
  explorerUrl,
  balanceHidden,
  onBalanceHiddenChange,
  onDisconnect,
  onDeposit,
  triggerClassName,
}: WalletMenuProps) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [pillHidden, setPillHidden] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function clearOpenCloseTimers() {
    if (openTimerRef.current) clearTimeout(openTimerRef.current)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    openTimerRef.current = null
    closeTimerRef.current = null
  }

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      clearOpenCloseTimers()
    }
  }, [])

  // While the pill is faded out but the panel hasn't opened yet, Escape restores the pill.
  useEffect(() => {
    if (!pillHidden || panelOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      clearOpenCloseTimers()
      setPillHidden(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pillHidden, panelOpen])

  function openMenu() {
    if (pillHidden || panelOpen) return
    clearOpenCloseTimers()
    setPillHidden(true)
    openTimerRef.current = setTimeout(() => {
      setPanelOpen(true)
      openTimerRef.current = null
    }, fadeDelayMs())
  }

  function closeMenu() {
    clearOpenCloseTimers()
    setPanelOpen(false)
    // Wait for the panel's slide-out before fading the pill back in, so they hand off cleanly.
    const restoreDelay = fadeDelayMs() === 0 ? 0 : SIDE_PANEL_EXIT_MS
    closeTimerRef.current = setTimeout(() => {
      setPillHidden(false)
      closeTimerRef.current = null
    }, restoreDelay)
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fullAddress)
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  function handleDeposit() {
    closeMenu()
    onDeposit()
  }

  const balanceLabel = `${formatUsdcAmount(usdcBalance)} USDC`
  const OverlayIcon = chainIconForChainId(chainId)

  return (
    <>
      <button
        type="button"
        className={[styles.pill, pillHidden && styles.pillHidden, triggerClassName]
          .filter(Boolean)
          .join(' ')}
        aria-haspopup="dialog"
        aria-expanded={panelOpen || pillHidden}
        tabIndex={pillHidden ? -1 : undefined}
        onClick={openMenu}
      >
        <span className={styles.pillIcon} aria-hidden>
          <WalletProviderIcon provider={walletProvider} size={24} />
        </span>
        <span className={styles.pillLabel}>{displayAddress}</span>
      </button>

      {/* No SidePanel title — the mockup panel has no header bar; the close X floats top-right. */}
      <SidePanel open={panelOpen} onClose={closeMenu} ariaLabel="Wallet">
        <div className={styles.panel}>
          <IconButton
            variant="frosted"
            size="sm"
            className={styles.close}
            aria-label="Close"
            icon={<XMarkIcon strokeWidth={2} aria-hidden />}
            onClick={closeMenu}
          />

          <div className={styles.body}>
            <div className={styles.identity}>
              <span className={styles.heroIcon} aria-hidden>
                <WalletProviderIcon provider={walletProvider} size={HERO_ICON_PX} />
              </span>
              <p className={styles.address}>{displayAddress}</p>
              <span className={styles.networkTag}>{networkLabel}</span>
            </div>

            <div className={styles.actionRow}>
              <BalanceActionButton
                variant="subtle"
                surface="tint"
                className={styles.labeledAction}
                label={balanceHidden ? 'Show' : 'Hide'}
                icon={
                  balanceHidden ? (
                    <EyeSlashIcon strokeWidth={1.5} aria-hidden />
                  ) : (
                    <EyeIcon strokeWidth={1.5} aria-hidden />
                  )
                }
                onClick={() => onBalanceHiddenChange(!balanceHidden)}
              />
              <BalanceActionButton
                variant="subtle"
                surface="tint"
                className={styles.labeledAction}
                label={copied ? 'Copied' : 'Copy'}
                icon={
                  copied ? (
                    <CheckIcon strokeWidth={1.5} aria-hidden />
                  ) : (
                    <ClipboardDocumentIcon strokeWidth={1.5} aria-hidden />
                  )
                }
                onClick={() => void handleCopy()}
              />
              <BalanceActionButton
                variant="subtle"
                surface="tint"
                className={styles.labeledAction}
                label="Explorer"
                icon={<ArrowTopRightOnSquareIcon strokeWidth={1.5} aria-hidden />}
                disabled={!explorerUrl}
                onClick={() => {
                  if (explorerUrl) window.open(explorerUrl, '_blank', 'noopener,noreferrer')
                }}
              />
              <BalanceActionButton
                variant="subtle"
                surface="tint"
                className={styles.labeledAction}
                label="Disconnect"
                icon={<PowerIcon strokeWidth={1.5} aria-hidden />}
                onClick={onDisconnect}
              />
            </div>

            <div className={styles.usdcBlock}>
              <p className={styles.usdcLabel}>Your USDC wallet balance</p>
              <div className={styles.usdcRow}>
                <span className={styles.usdcIcon} aria-hidden>
                  <span className={styles.usdcGlyph}>
                    <TokenUSDC size={USDC_GLYPH_SIZE} variant="branded" />
                  </span>
                  {OverlayIcon ? (
                    <span className={styles.usdcOverlay}>
                      <OverlayIcon size={USDC_OVERLAY_ICON_PX} variant="branded" />
                    </span>
                  ) : null}
                </span>
                <div className={styles.tokenIdentity}>
                  <p className={styles.tokenName}>USDC</p>
                  <p className={styles.tokenNetwork}>{networkLabel}</p>
                </div>
                <p className={styles.tokenBalance}>
                  <BalanceScrambleValue value={balanceLabel} revealed={!balanceHidden} />
                </p>
              </div>
            </div>

            <SendButton
              variant="gradient"
              label="Shield your USDC"
              icon={<PlusIcon className={styles.depositIcon} strokeWidth={1.5} aria-hidden />}
              className={styles.depositButton}
              onClick={handleDeposit}
            />
          </div>
        </div>
      </SidePanel>
    </>
  )
}
