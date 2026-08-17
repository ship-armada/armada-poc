// ABOUTME: Send/Withdraw recipient step — serif prompt, a pill address input (0zk or 0x) with Paste/Clear,
// ABOUTME: a public-only destination-chain selector, and a reveal footer (privacy badge + Continue) once the address is valid.

import { useState } from 'react'
import { XMarkIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
import { ArmadaLogo, Button } from '@/design'
import { modalStepBodyEnter } from '@/design'
import { ChainSelect } from '@/components/ui'
import { isShieldedAddress, validateEvmAddress } from '@/lib/address'
import { truncateAddress } from '@/lib/format'
import styles from './SendRecipientStep.module.css'

/** Which flow the shared Send/Withdraw modal is running as — drives minimal copy differences. */
export type SendFlowVariant = 'send' | 'withdraw'

export interface SendRecipientStepProps {
  variant: SendFlowVariant
  recipient: string
  onRecipientChange: (next: string) => void
  destChainId: number
  onDestChainIdChange: (chainId: number) => void
  /** Surfaced when the chosen public destination chain has no deployment manifest. */
  destDeploymentError?: string
  onContinue: () => void
}

export function SendRecipientStep({
  // `variant` is retained on the props (the modal passes it) but the prompt is intentionally
  // "Where do you want to send your USDC?" for both send + withdraw (per design).
  recipient,
  onRecipientChange,
  destChainId,
  onDestChainIdChange,
  destDeploymentError,
  onContinue,
}: SendRecipientStepProps) {
  const [inputFocused, setInputFocused] = useState(false)

  const recipientTrimmed = recipient.trim()
  const hasInput = recipientTrimmed.length > 0
  const isPrivate = isShieldedAddress(recipientTrimmed)
  const evmValidation = validateEvmAddress(recipientTrimmed)
  // A public recipient is a valid 0x address that is NOT a shielded 0zk address.
  const isPublic = !isPrivate && evmValidation.valid
  const recipientValid = isPrivate || isPublic
  const recipientInvalid = hasInput && !recipientValid
  const recipientError = recipientInvalid
    ? evmValidation.error === 'checksum'
      ? 'Address checksum mismatch — double-check for typos.'
      : 'Enter a valid shielded (0zk…) or public wallet (0x…) address.'
    : undefined

  // Full address while focused/editing; middle-truncated when blurred so long addresses stay legible.
  const inputDisplayValue = inputFocused || !hasInput ? recipient : truncateAddress(recipientTrimmed)

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText()
      if (text.trim()) onRecipientChange(text.trim())
    } catch {
      // Clipboard read blocked/unavailable — no-op; the user can still type/paste manually.
    }
  }

  const canContinue = recipientValid && !destDeploymentError

  return (
    <div className={styles.root}>
      <div className={[styles.body, modalStepBodyEnter].join(' ')}>
        <h1 className={styles.title}>
          Where do you want to
          <br />
          send your USDC?
        </h1>

        <div className={styles.addressBlock}>
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
            />
            {!hasInput ? (
              <button type="button" className={styles.pasteButton} onClick={() => void handlePaste()}>
                Paste
              </button>
            ) : (
              <button
                type="button"
                className={styles.clearButton}
                aria-label="Clear address"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onRecipientChange('')}
              >
                <XMarkIcon className={styles.clearIcon} strokeWidth={2} aria-hidden />
              </button>
            )}
          </div>

          {/* Chain selection only applies to public 0x recipients; a 0zk transfer stays on the hub. */}
          {isPublic ? (
            <div className={styles.chainSlot}>
              <ChainSelect label="Destination chain" value={destChainId} onChange={onDestChainIdChange} />
            </div>
          ) : null}

          {recipientError ? (
            <div className={styles.destError} role="alert">
              {recipientError}
            </div>
          ) : null}
          {destDeploymentError ? (
            <div className={styles.destError} role="alert">
              {destDeploymentError}
            </div>
          ) : null}
        </div>
      </div>

      {/* Footer reveals only once the address is valid (matches the mockup — no persistent buttons). */}
      {recipientValid ? (
        <div className={[styles.footer, styles.actionRowReveal].join(' ')}>
          <div className={styles.privacyBadge}>
            <span
              className={[styles.privacyIcon, isPrivate ? styles.brandBadge : styles.privacyIconPublic]
                .join(' ')}
              aria-hidden
            >
              {isPrivate ? (
                <ArmadaLogo variant="mark" markTone="white" className={styles.brandMark} />
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
          <Button
            variant="primary"
            size="lg"
            label="Continue"
            showIcon={false}
            className={styles.continueButton}
            disabled={!canContinue}
            onClick={onContinue}
          />
        </div>
      ) : null}
    </div>
  )
}
