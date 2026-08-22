// ABOUTME: Send/Withdraw recipient step — a frost card (title + address input with Clear + a paste row that
// ABOUTME: previews a valid 0zk/0x on the clipboard + public-only chain selector + privacy badge once valid) over an always-visible Cancel / Continue action row + a recent-recipients list.

import { useEffect, useId, useState } from 'react'
import { XMarkIcon, GlobeAltIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import { ArmadaLogo, Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import iconButtonStyles from '@/design/components/IconButton/IconButton.module.css'
import { ChainSelect } from '@/components/ui'
import { AmountFieldWarning } from '@/components/ui/AmountFieldWarning'
import { isShieldedAddress, validateEvmAddress } from '@/lib/address'
import { truncateAddress } from '@/lib/format'
import { useMobileLayout } from '@/hooks/useMobileLayout'
import { RecentAddressList } from './RecentAddressList'
import type { RecentRecipient } from '@/lib/tx/recentRecipients'
import styles from './SendRecipientStep.module.css'

/** Which flow the shared Send/Withdraw modal is running as — drives minimal copy differences. */
export type SendFlowVariant = 'send' | 'withdraw'

/** Returns the trimmed clipboard text if it's a valid shielded (0zk) or public (0x) address, else null. */
function validClipboardAddress(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (isShieldedAddress(trimmed)) return trimmed
  if (validateEvmAddress(trimmed).valid) return trimmed
  return null
}

export interface SendRecipientStepProps {
  variant: SendFlowVariant
  recipient: string
  onRecipientChange: (next: string) => void
  destChainId: number
  onDestChainIdChange: (chainId: number) => void
  /** Surfaced when the chosen public destination chain has no deployment manifest. */
  destDeploymentError?: string
  /** Previously-used recipients, newest-first — rendered as one-tap rows below the action row. */
  recentAddresses: RecentRecipient[]
  /** Fills the recipient (and restores its destination chain) from a recent row. */
  onSelectRecent: (item: RecentRecipient) => void
  /** Dismisses the flow — wired to the modal's close in SendModal. */
  onCancel: () => void
  onContinue: () => void
}

export function SendRecipientStep({
  variant,
  recipient,
  onRecipientChange,
  destChainId,
  onDestChainIdChange,
  destDeploymentError,
  recentAddresses,
  onSelectRecent,
  onCancel,
  onContinue,
}: SendRecipientStepProps) {
  const [inputFocused, setInputFocused] = useState(false)
  const isMobile = useMobileLayout()
  // Trimmed clipboard content (null if empty / unreadable), used by the paste row. Probed on open +
  // whenever the tab regains focus (the user may copy then return).
  const [clipboardText, setClipboardText] = useState<string | null>(null)

  const recipientTrimmed = recipient.trim()
  const hasInput = recipientTrimmed.length > 0
  // The valid 0zk/0x address on the clipboard, or null when the clipboard content isn't a valid address.
  const clipboardAddress = clipboardText ? validClipboardAddress(clipboardText) : null

  useEffect(() => {
    if (hasInput) {
      setClipboardText(null)
      return
    }
    // No clipboard API (e.g. jsdom, insecure context) — nothing to preview.
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return
    let cancelled = false
    async function probe() {
      try {
        const text = await navigator.clipboard.readText()
        if (!cancelled) setClipboardText(text.trim() || null)
      } catch {
        // Clipboard read blocked/unavailable — no row; the user can still type/paste manually.
        if (!cancelled) setClipboardText(null)
      }
    }
    void probe()
    function reprobe() {
      void probe()
    }
    window.addEventListener('focus', reprobe)
    document.addEventListener('visibilitychange', reprobe)
    return () => {
      cancelled = true
      window.removeEventListener('focus', reprobe)
      document.removeEventListener('visibilitychange', reprobe)
    }
  }, [hasInput])
  const isPrivate = isShieldedAddress(recipientTrimmed)
  const evmValidation = validateEvmAddress(recipientTrimmed)
  // A public recipient is a valid 0x address that is NOT a shielded 0zk address.
  const isPublic = !isPrivate && evmValidation.valid
  const recipientValid = isPrivate || isPublic
  const recipientInvalid = hasInput && !recipientValid
  // Terse single-line copy so it reads cleanly in the above-field warning tooltip (matches the
  // amount step's over-balance tooltip).
  const recipientError = recipientInvalid
    ? evmValidation.error === 'checksum'
      ? 'Address checksum mismatch'
      : 'Enter a valid 0zk or 0x address'
    : undefined
  const recipientErrorId = useId()

  // Full address while focused/editing; middle-truncated when blurred so long addresses stay legible.
  const inputDisplayValue = inputFocused || !hasInput ? recipient : truncateAddress(recipientTrimmed)

  // The prompt differs by variant per design: withdraw leans into "where", send is imperative.
  const title = variant === 'withdraw' ? 'Where do you want to send your USDC?' : 'Send your USDC to:'

  const canContinue = recipientValid && !destDeploymentError

  return (
    <div className={styles.root}>
      <div className={`${styles.card} ${modalStepBodyEnter}`}>
        <h1 className={`armada-text-ui-body-lg ${styles.cardTitle}`}>{title}</h1>

        <div className={styles.addressBlock}>
          <AmountFieldWarning
            id={recipientErrorId}
            visible={Boolean(recipientError)}
            message={recipientError ?? ''}
          >
            <div className={styles.addressField}>
              <input
                className={styles.addressInput}
                type="text"
                value={inputDisplayValue}
                title={recipientTrimmed || undefined}
                onChange={(e) => onRecipientChange(e.target.value)}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                placeholder="Enter address"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                aria-label="Recipient address"
                aria-invalid={recipientInvalid || undefined}
                aria-describedby={recipientError ? recipientErrorId : undefined}
              />
              {hasInput ? (
                <button
                  type="button"
                  className={styles.clearButton}
                  aria-label="Clear address"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onRecipientChange('')}
                >
                  <XMarkIcon className={styles.clearIcon} strokeWidth={2} aria-hidden />
                </button>
              ) : null}
            </div>
          </AmountFieldWarning>

          {/* Empty state only: a paste row shown whenever the clipboard has content. A valid 0zk/0x is
              previewed + pastes on click; anything else shows "Not a valid address" and is disabled. */}
          {!hasInput && clipboardText ? (
            <button
              type="button"
              className={styles.clipboardPaste}
              disabled={!clipboardAddress}
              onClick={() => {
                if (clipboardAddress) onRecipientChange(clipboardAddress)
              }}
            >
              <span
                className={[
                  iconButtonStyles.button,
                  iconButtonStyles.sizeMd,
                  iconButtonStyles.frosted,
                  styles.clipboardPasteIcon,
                ].join(' ')}
                aria-hidden
              >
                <span className={iconButtonStyles.icon}>
                  <ClipboardDocumentIcon strokeWidth={1.5} />
                </span>
              </span>
              <span className={styles.clipboardPasteCopy}>
                <span className={styles.clipboardPasteLabel}>Paste from clipboard</span>
                {clipboardAddress ? (
                  <span className={styles.clipboardPasteAddress} title={clipboardAddress}>
                    {truncateAddress(clipboardAddress)}
                  </span>
                ) : (
                  <span className={styles.clipboardPasteAddressInvalid}>Not a valid address</span>
                )}
              </span>
            </button>
          ) : null}

          {/* Chain selection only applies to public 0x recipients; a 0zk transfer stays on the hub. */}
          {isPublic ? (
            <div className={styles.chainSlot}>
              <ChainSelect label="Destination chain" value={destChainId} onChange={onDestChainIdChange} />
            </div>
          ) : null}

          {destDeploymentError ? (
            <div className={styles.destError} role="alert">
              {destDeploymentError}
            </div>
          ) : null}
        </div>

        {/* Privacy badge reveals inside the card once the address is valid. */}
        {recipientValid ? (
          <div className={[styles.privacyBadge, styles.actionRowReveal].join(' ')} role="status">
            <span
              className={[styles.privacyIcon, isPrivate ? styles.brandBadge : styles.privacyIconPublic].join(' ')}
              aria-hidden
            >
              {isPrivate ? (
                <ArmadaLogo variant="mark" markTone="deep" className={styles.brandMark} />
              ) : (
                <GlobeAltIcon className={styles.privacyIconSvg} strokeWidth={1.75} />
              )}
            </span>
            <div className={styles.privacyCopy}>
              <span className={styles.privacyTitle}>{isPrivate ? 'Private address' : 'Public address'}</span>
              <span className={styles.privacySubtitle}>
                {isPrivate ? 'Transaction will be fully private' : "Transfer won't be fully private"}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Always-visible action row — Continue stays disabled + labeled "Enter address" until valid. */}
      <div className={`${styles.buttonRow} ${modalActionRowEnter}`}>
        <Button variant="secondary" size="lg" label="Cancel" showIcon={false} onClick={onCancel} />
        <Button
          variant="primary"
          size="lg"
          label={recipientValid ? 'Continue' : 'Enter address'}
          showIcon={false}
          disabled={!canContinue}
          onClick={onContinue}
        />
      </div>

      {/* Recent recipients — hidden on mobile once a valid address is entered so the keyboard + CTAs
          own the viewport (matches the mockup); empty history renders nothing. */}
      {!(isMobile && recipientValid) ? (
        <RecentAddressList items={recentAddresses} onSelect={onSelectRecent} />
      ) : null}
    </div>
  )
}
