// ABOUTME: Header pill for the unlocked shielded (0zk) address — click to copy the full value to the clipboard.
// ABOUTME: Renders nothing when no shielded wallet is unlocked (state.status !== 'unlocked' or railgunAddress missing).

import { useEffect, useRef, useState } from 'react'
import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/solid'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { truncateAddressEnds } from '@/lib/format'
import styles from './ShieldedAddressPill.module.css'

const COPY_FEEDBACK_MS = 2000

export function ShieldedAddressPill() {
  const { state } = useShieldedWallet()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  if (state?.status !== 'unlocked' || !state.railgunAddress) {
    return null
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
    <button
      type="button"
      className={styles.pill}
      onClick={() => void handleCopy()}
      aria-label={copied ? 'Shielded address copied' : `Copy shielded address ${fullAddress}`}
      title={fullAddress}
    >
      <span className={styles.icon} aria-hidden>
        {copied ? (
          <CheckIcon width={14} height={14} />
        ) : (
          <ClipboardDocumentIcon width={14} height={14} />
        )}
      </span>
      <span className={styles.label}>{copied ? 'Copied' : display}</span>
    </button>
  )
}
