// ABOUTME: Mobile wallet menu as a dark bottom sheet (copy address / disconnect).
// ABOUTME: Ported from the armada-crowdfund mockup (Header/WalletMenuSheet.tsx).

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRightOnRectangleIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  WalletIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import {
  WalletMetamask,
  WalletPhantom,
  WalletWalletConnect,
} from '@web3icons/react'
import buttonStyles from '../Button/Button.module.css'
import styles from './WalletMenuSheet.module.css'

/** Exit duration — keep in sync with invite bottom-sheet motion (220ms). */
const SHEET_EXIT_MS = 220

const WALLET_ICON_PX = 48
const CLOSE_ICON_PX = 20

function WalletProviderIcon({
  provider,
  size = WALLET_ICON_PX,
}: {
  provider?: string
  size?: number
}) {
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

export interface WalletMenuSheetProps {
  id: string
  open: boolean
  onClose: () => void
  walletAddress?: string
  walletCopyAddress?: string
  walletProvider?: string
  usdcBalance?: number
  onDisconnect?: () => void
}

export function WalletMenuSheet({
  id,
  open,
  onClose,
  walletAddress = '',
  walletCopyAddress,
  walletProvider,
  usdcBalance = 0,
  onDisconnect,
}: WalletMenuSheetProps) {
  const [copied, setCopied] = useState(false)
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const copyTarget = walletCopyAddress ?? walletAddress

  useEffect(() => {
    if (open) {
      setMounted(true)
      setExiting(false)
      return
    }
    if (!mounted) return
    setExiting(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setExiting(false)
    }, SHEET_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open) setCopied(false)
  }, [open])

  useEffect(() => {
    if (!open || exiting) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, exiting, onClose])

  useEffect(() => {
    if (!mounted) return
    const html = document.documentElement
    const body = document.body
    const scrollY = window.scrollY
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyWidth: body.style.width,
    }
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'
    return () => {
      html.style.overflow = prev.htmlOverflow
      body.style.overflow = prev.bodyOverflow
      body.style.position = prev.bodyPosition
      body.style.top = prev.bodyTop
      body.style.width = prev.bodyWidth
      window.scrollTo(0, scrollY)
    }
  }, [mounted])

  useEffect(() => {
    if (!open || exiting) return
    sheetRef.current?.focus({ preventScroll: true })
  }, [open, exiting])

  if (!mounted || typeof document === 'undefined') return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyTarget)
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const handleDisconnect = () => {
    onDisconnect?.()
    onClose()
  }

  const balanceLabel = `${usdcBalance.toLocaleString('en-US')} USDC`

  return createPortal(
    <>
      <div
        className={[styles.scrim, exiting ? styles.scrimExit : undefined]
          .filter(Boolean)
          .join(' ')}
        role="presentation"
        onClick={exiting ? undefined : onClose}
      />
      <div
        ref={sheetRef}
        id={id}
        className={[styles.sheet, exiting ? styles.sheetExit : undefined]
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.handle} aria-hidden />
        <div className={styles.topRow}>
          <h2 id={titleId} className={styles.title}>
            Wallet
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close wallet menu"
          >
            <XMarkIcon width={CLOSE_ICON_PX} height={CLOSE_ICON_PX} aria-hidden />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.identity}>
            <span className={styles.walletIcon}>
              <WalletProviderIcon provider={walletProvider} />
            </span>
            <p className={styles.address}>{walletAddress}</p>
            <p className={styles.balance}>{balanceLabel}</p>
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={[
                buttonStyles.btn,
                buttonStyles.secondary,
                buttonStyles.lg,
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
                className={[
                  buttonStyles.btn,
                  buttonStyles.secondary,
                  buttonStyles.lg,
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
        </div>
      </div>
    </>,
    document.body,
  )
}
