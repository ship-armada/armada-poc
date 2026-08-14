// ABOUTME: Onboarding step — prompts the user to sign the EIP-712 enrollment message with their connected EVM wallet.
// ABOUTME: Gates the Sign CTA on wagmi connection state; surfaces a "Connect wallet" button (RainbowKit) when disconnected. No mnemonic display — the recovery secret is root_secret, exported as an encrypted backup in later steps.

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { Button, Text } from '@/design'
import {
  isNonDeterministicSignerError,
  type NonDeterministicSignerErrorReason,
} from '@/lib/crypto/determinism'
import { normalizeEnrollmentError } from '@/lib/shielded/enrollmentErrors'
import styles from './SignEnrollmentStep.module.css'

export interface SignEnrollmentStepProps {
  /**
   * Called to trigger the wagmi sign prompt. Wired to `useShieldedWallet().signIn()` by the
   * parent. The function may throw `NonDeterministicSignerError`; when it does AND
   * `onSignerIncompatible` is supplied, we hand the typed error to the parent to render a
   * dedicated error screen instead of dumping the message into an inline alert.
   */
  onSign: () => Promise<void>
  onBack: () => void
  /**
   * Optional callback for the typed `NonDeterministicSignerError` path. When undefined, the
   * error is rendered inline like any other error (back-compat for OnboardingFlow v1). When
   * supplied, the inline error is suppressed and the parent owns the screen transition.
   */
  onSignerIncompatible?: (reason: NonDeterministicSignerErrorReason) => void
}

export function SignEnrollmentStep({
  onSign,
  onBack,
  onSignerIncompatible,
}: SignEnrollmentStepProps) {
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSign() {
    setError(null)
    setSubmitting(true)
    try {
      await onSign()
    } catch (err) {
      // V2 amendment: a typed NonDeterministicSignerError gets a dedicated screen owned by the
      // parent. We don't render the message inline because the parent screen carries the
      // wallet-compatibility list + paste/backup fallback CTAs that the user needs to act on.
      // Without an onSignerIncompatible callback (legacy callers / OnboardingFlow v1), fall back
      // to the inline error rendering so we never silently swallow the error.
      if (isNonDeterministicSignerError(err) && onSignerIncompatible) {
        onSignerIncompatible(err.reason)
        return
      }
      setError(normalizeEnrollmentError(err).message)
    } finally {
      setSubmitting(false)
    }
  }

  // Two-button states: not-connected → open RainbowKit; connected → trigger sign.
  // We intentionally do not auto-fire the sign after connect; the user explicitly clicks twice
  // so the wallet prompts (connect + sign) don't feel chained or surprising.
  const primaryLabel = isConnected
    ? submitting
      ? 'Waiting for signature…'
      : 'Sign message'
    : 'Connect wallet'
  const primaryDisabled = isConnected ? submitting : !openConnectModal
  const primaryLoading = isConnected && submitting
  const primaryOnClick = isConnected ? handleSign : openConnectModal ?? undefined

  return (
    <div className={styles.root}>
      <Text variant="display-lg" as="h2" className={styles.title}>
        Sign to generate your keys
      </Text>
      <p className={styles.body}>
        Your shielded wallet keys are derived from a signature your EVM wallet produces against a fixed
        message. This is <strong>not a transaction</strong> — no
        funds move, no chain state changes.
      </p>
      <p className={styles.bodyMuted}>
        Your wallet will prompt twice on first setup — we use both signatures to confirm sign-in
        recovery will work later.
      </p>
      <p className={styles.bodyMuted}>
        Before signing, check that your wallet's prompt shows this site's URL — that is the only
        reliable way to tell a real Armada session from a phishing site.
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="md"
          label={primaryLabel}
          showIcon={false}
          disabled={primaryDisabled}
          loading={primaryLoading}
          onClick={primaryOnClick}
        />
        <Button
          variant="ghost"
          size="md"
          label="Back"
          showIcon={false}
          disabled={submitting}
          onClick={onBack}
        />
      </div>
    </div>
  )
}
