// ABOUTME: Connected-wallet control — a pill trigger (provider icon + address) that opens a right-edge SidePanel with the EVM wallet identity, actions (hide/copy/explorer/disconnect, each tooltipped), USDC balance, and a Deposit CTA.
// ABOUTME: Replaces the old dropdown WalletPillMenu; matches the mockup's side-panel design. Balance-hide is shared app-wide via balanceHiddenAtom (owned by the parent).

import { useEffect, useRef, useState } from 'react'
import {
  ArrowRightOnRectangleIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  EyeIcon,
  EyeSlashIcon,
  PlusIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { IconButton, SidePanel, Tooltip } from '@/design'
import { WalletProviderIcon } from '@/components/ui/WalletProviderIcon'
import { chainIconForChainId } from '@/components/ui/chainIcons'
import { SendButton } from '@/components/dashboard/SendButton'
import { BalanceScrambleValue } from '@/components/dashboard/BalanceScrambleValue'
import { formatUsdcAmount } from '@/components/dashboard/dashboardFormat'
import styles from './WalletMenu.module.css'

const HERO_ICON_PX = 56
const USDC_GLYPH_PX = 40
const USDC_GLYPH_SIZE = Math.round((USDC_GLYPH_PX * 24) / 18)
const USDC_OVERLAY_ICON_PX = 16

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
  /** Address explorer URL; the "View on explorer" action is disabled when absent (e.g. local Anvil). */
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
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

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
    setOpen(false)
    onDeposit()
  }

  const balanceLabel = `${formatUsdcAmount(usdcBalance)} USDC`
  const OverlayIcon = chainIconForChainId(chainId)

  return (
    <>
      <button
        type="button"
        className={[styles.pill, triggerClassName].filter(Boolean).join(' ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className={styles.pillIcon} aria-hidden>
          <WalletProviderIcon provider={walletProvider} size={24} />
        </span>
        <span className={styles.pillLabel}>{displayAddress}</span>
      </button>

      {/* No SidePanel title — the mockup panel has no header bar; the close X floats top-right. */}
      <SidePanel open={open} onClose={() => setOpen(false)} ariaLabel="Wallet">
        <div className={styles.panel}>
          <div className={styles.toolbar}>
            <button type="button" className={styles.close} aria-label="Close" onClick={() => setOpen(false)}>
              <XMarkIcon width={20} height={20} strokeWidth={2} aria-hidden />
            </button>
          </div>

          <div className={styles.body}>
          <div className={styles.identity}>
            <span className={styles.heroIcon} aria-hidden>
              <WalletProviderIcon provider={walletProvider} size={HERO_ICON_PX} />
            </span>
            <p className={styles.address}>{displayAddress}</p>
            <span className={styles.networkTag}>{networkLabel}</span>
          </div>

          <div className={styles.actionRow}>
            <Tooltip variant="action" content={balanceHidden ? 'Show balance' : 'Hide balance'}>
              <IconButton
                variant="secondary"
                icon={
                  balanceHidden ? (
                    <EyeSlashIcon className={styles.actionIcon} strokeWidth={1.5} aria-hidden />
                  ) : (
                    <EyeIcon className={styles.actionIcon} strokeWidth={1.5} aria-hidden />
                  )
                }
                aria-label={balanceHidden ? 'Show balance' : 'Hide balance'}
                onClick={() => onBalanceHiddenChange(!balanceHidden)}
              />
            </Tooltip>
            <Tooltip variant="action" content={copied ? 'Copied' : 'Copy address'}>
              <IconButton
                variant="secondary"
                icon={
                  copied ? (
                    <CheckIcon className={styles.actionIcon} strokeWidth={1.5} aria-hidden />
                  ) : (
                    <ClipboardDocumentIcon className={styles.actionIcon} strokeWidth={1.5} aria-hidden />
                  )
                }
                aria-label={copied ? 'Address copied' : 'Copy wallet address'}
                onClick={() => void handleCopy()}
              />
            </Tooltip>
            <Tooltip variant="action" content="View on explorer">
              <IconButton
                variant="secondary"
                icon={<ArrowTopRightOnSquareIcon className={styles.actionIcon} strokeWidth={1.5} aria-hidden />}
                aria-label="View wallet on explorer"
                disabled={!explorerUrl}
                onClick={() => {
                  if (explorerUrl) window.open(explorerUrl, '_blank', 'noopener,noreferrer')
                }}
              />
            </Tooltip>
            <Tooltip variant="action" content="Disconnect">
              <IconButton
                variant="secondary"
                icon={<ArrowRightOnRectangleIcon className={styles.actionIcon} strokeWidth={1.5} aria-hidden />}
                aria-label="Disconnect wallet"
                onClick={onDisconnect}
              />
            </Tooltip>
          </div>

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

          <SendButton
            variant="gradient"
            label="DEPOSIT"
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
