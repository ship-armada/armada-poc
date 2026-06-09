// ABOUTME: Connected-wallet pill + dropdown — copy address and disconnect (crowdfund Header parity).

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRightOnRectangleIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  WalletIcon,
} from '@heroicons/react/24/outline'
import { CheckIcon } from '@heroicons/react/24/solid'
import {
  WalletMetamask,
  WalletPhantom,
  WalletWalletConnect,
} from '@web3icons/react'
import { ArmadaSymbol } from '../ArmadaSymbol/ArmadaSymbol'
import buttonStyles from '../Button/Button.module.css'
import styles from './WalletPillMenu.module.css'

export interface WalletPillMenuProps {
  /** Truncated address shown on the pill and in the menu header. */
  displayAddress: string
  /** Full address copied to clipboard. */
  copyAddress: string
  walletProvider?: string
  /** Optional wallet balance label (unshielded USDC total). */
  usdcBalance?: number
  onDisconnect?: () => void
  /**
   * Extra class applied to the trigger button so consumers can override its background, border,
   * or other Button-derived secondary-variant defaults without forking the component. Used by
   * armada-interface to swap the default transparent pill for a solid black background.
   */
  triggerClassName?: string
  /**
   * Optional content rendered inside the dropdown card, below the copy/disconnect actions.
   * Consumer-supplied. `armada-interface` uses this to surface a "Shielded identity" section
   * (post V2 redesign: the EVM and shielded addresses are 1:1, so they share one pill).
   * Consumers without a shielded wallet (crowdfund observer/committer/admin) omit the prop and
   * render no extra section — back-compat.
   *
   * See packages/ui/src/components/CLAUDE.md "Approved deviations from byte-identical port"
   * for the design-system deviation rationale (same precedent as WalletButton's `disabled` prop).
   */
  extraSection?: ReactNode
  /**
   * Optional truncated shielded (0zk…) address to render as a second row beneath the EVM
   * address on the pill trigger. When supplied, the provider icon is replaced with the
   * `ArmadaSymbol` flotilla glyph (the trigger represents the user's Armada identity, not
   * their wallet provider). When undefined, the trigger renders the original single-row
   * EVM-only layout — crowdfund consumers without a shielded wallet are unaffected.
   *
   * Same design-system deviation precedent as `extraSection` / WalletButton's `disabled`.
   */
  shieldedAddress?: string
}

const PROVIDER_ICON_PX = 20
const CARD_ICON_PX = 48

function WalletProviderIcon({ provider, size = PROVIDER_ICON_PX }: { provider?: string; size?: number }) {
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

export function WalletPillMenu({
  displayAddress,
  copyAddress,
  walletProvider,
  usdcBalance = 0,
  onDisconnect,
  triggerClassName,
  extraSection,
  shieldedAddress,
}: WalletPillMenuProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyAddress)
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const handleDisconnect = () => {
    setOpen(false)
    onDisconnect?.()
  }

  const balanceLabel = `${usdcBalance.toLocaleString('en-US')} USDC`

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={[
          buttonStyles.btn,
          buttonStyles.secondary,
          buttonStyles.md,
          buttonStyles.noIcon,
          styles.trigger,
          shieldedAddress && styles.triggerTwoRow,
          triggerClassName,
        ].filter(Boolean).join(' ')}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
        onClick={() => setOpen(prev => !prev)}
      >
        {shieldedAddress ? (
          // Two-row layout: each row pairs an identity-specific glyph with its address. The
          // outer stack handles vertical layout; each `.triggerRow` is its own flex line with
          // the glyph and label aligned to a shared baseline.
          <span className={styles.triggerStack}>
            <span className={styles.triggerRow}>
              <span className={styles.triggerIcon}>
                <WalletProviderIcon provider={walletProvider} size={14} />
              </span>
              <span className={styles.triggerLabel}>{displayAddress}</span>
            </span>
            <span className={styles.triggerRow}>
              <span className={styles.triggerIcon}>
                <ArmadaSymbol size={14} />
              </span>
              <span className={[styles.triggerLabel, styles.triggerShieldedLabel].join(' ')}>
                {shieldedAddress}
              </span>
            </span>
          </span>
        ) : (
          <>
            <span className={styles.triggerIcon}>
              <WalletProviderIcon provider={walletProvider} size={16} />
            </span>
            <span className={styles.triggerLabel}>{displayAddress}</span>
          </>
        )}
        <ChevronDownIcon
          className={[styles.chevron, open && styles.chevronOpen].filter(Boolean).join(' ')}
          aria-hidden
        />
      </button>

      {open ? (
        <div id={menuId} className={styles.menu} role="menu">
          <div className={styles.card} role="none">
            <div className={styles.cardIdentity}>
              <span className={styles.cardIcon}>
                <WalletProviderIcon provider={walletProvider} size={CARD_ICON_PX} />
              </span>
              <p className={styles.cardAddress}>{displayAddress}</p>
              <p className={styles.cardBalance}>{balanceLabel}</p>
            </div>

            <div className={styles.cardActions}>
              <button
                type="button"
                role="menuitem"
                className={[
                  buttonStyles.btn,
                  buttonStyles.secondary,
                  buttonStyles.lg,
                  buttonStyles.noIcon,
                  styles.actionBtn,
                  copied && styles.actionBtnCopied,
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => void handleCopy()}
              >
                {copied ? (
                  <CheckIcon className={styles.actionIcon} aria-hidden />
                ) : (
                  <ClipboardDocumentIcon className={styles.actionIcon} aria-hidden />
                )}
                <span className={styles.actionLabel}>{copied ? 'Copied' : 'Copy address'}</span>
              </button>

              {onDisconnect ? (
                <button
                  type="button"
                  role="menuitem"
                  className={[
                    buttonStyles.btn,
                    buttonStyles.secondary,
                    buttonStyles.lg,
                    buttonStyles.noIcon,
                    styles.actionBtn,
                    styles.disconnect,
                  ].join(' ')}
                  onClick={handleDisconnect}
                >
                  <ArrowRightOnRectangleIcon className={styles.actionIcon} aria-hidden />
                  <span className={styles.actionLabel}>Disconnect</span>
                </button>
              ) : null}
            </div>

            {extraSection}
          </div>
        </div>
      ) : null}
    </div>
  )
}
