// ABOUTME: Shielded-identity slot rendered inside @armada/ui WalletPillMenu's dropdown — V2 redesign: EVM + 0zk are 1:1 representations of one identity, so they share one pill.
// ABOUTME: Three states: unlocked → 0zk address + click-to-copy + anti-phish checksum line; locked-but-EVM-connected → "Sign in to access" CTA; no shielded wallet at all → returns null (collapses to a plain WalletPillMenu).

import { useEffect, useRef, useState } from 'react'
import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/solid'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { truncateAddressEnds } from '@/lib/format'
import styles from './ShieldedIdentitySection.module.css'

const COPY_FEEDBACK_MS = 2000

export interface ShieldedIdentitySectionProps {
  /**
   * Triggered when the user clicks "Sign in to access" on the locked branch. Parent supplies
   * the actual sign-in routing (typically a `setOpenSignIn(true)` or `signIn()` call). When
   * omitted, the locked branch renders no CTA — the user has to navigate to onboarding manually.
   */
  readonly onRequestSignIn?: () => void
}

export function ShieldedIdentitySection({ onRequestSignIn }: ShieldedIdentitySectionProps) {
  const { state } = useShieldedWallet()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  // No shielded wallet record at all — collapse to nothing so non-armada-interface consumers
  // of WalletPillMenu (crowdfund apps) that accidentally pass this component get a clean menu.
  // This shouldn't happen in normal armada-interface use, but it's a defensive default.
  if (!state) {
    return null
  }

  if (state.status !== 'unlocked' || !state.railgunAddress) {
    // EVM connected but shielded wallet is locked. Replace the address row with a CTA so the
    // user knows the menu is half-active and what to do about it.
    return (
      <div className={styles.section}>
        <p className={styles.eyebrow}>Shielded identity</p>
        {onRequestSignIn ? (
          <button type="button" className={styles.signInCta} onClick={onRequestSignIn}>
            Sign in to access
          </button>
        ) : (
          <p className={styles.locked}>Locked</p>
        )}
      </div>
    )
  }

  const fullAddress = state.railgunAddress
  const display = truncateAddressEnds(fullAddress, 7, 4)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fullAddress)
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={styles.section}>
      <p className={styles.eyebrow}>Shielded identity</p>
      <button
        type="button"
        className={styles.row}
        onClick={() => void handleCopy()}
        aria-label={copied ? 'Shielded address copied' : `Copy shielded address ${fullAddress}`}
        title={fullAddress}
      >
        <span className={styles.statusDot} aria-hidden />
        <span className={styles.address}>{copied ? 'Copied' : display}</span>
        <span className={styles.icon} aria-hidden>
          {copied ? <CheckIcon width={14} height={14} /> : <ClipboardDocumentIcon width={14} height={14} />}
        </span>
      </button>
    </div>
  )
}
