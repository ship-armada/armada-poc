// ABOUTME: Onboarding step — prompts the user to sign the EIP-712 enrollment message with their connected EVM wallet.
// ABOUTME: Gates the Sign CTA on wagmi connection state; surfaces a "Connect wallet" button (RainbowKit) when disconnected. No mnemonic display — the recovery secret is root_secret, exported as an encrypted backup in later steps.

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAtomValue } from 'jotai'
import { Button, Text } from '@armada/ui'
import { normalizeEnrollmentError } from '@/lib/railgun/enrollmentErrors'
import { retryRailgunEngineInit } from '@/lib/railgun/init'
import { railgunEngineAtom } from '@/state/wallet'
import styles from './SignEnrollmentStep.module.css'

export interface SignEnrollmentStepProps {
  /** Called to trigger the wagmi sign prompt. Wired to useShieldedWallet().enroll() by the parent. */
  onSign: () => Promise<void>
  onBack: () => void
}

export function SignEnrollmentStep({ onSign, onBack }: SignEnrollmentStepProps) {
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const engine = useAtomValue(railgunEngineAtom)
  const [submitting, setSubmitting] = useState(false)
  const [retryingEngine, setRetryingEngine] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // While submitting, the parent's enroll() runs initRailgunEngine first (engine state goes
  // cold → warming → ready), then signTypedData. Surface the warming step explicitly so the
  // user doesn't think MetaMask is hung — engine init can take a couple seconds on a cold
  // load (WASM proving stack + artifact store + merkle scan setup).
  const warming = submitting && engine.state === 'warming'

  async function handleSign() {
    setError(null)
    setSubmitting(true)
    try {
      await onSign()
    } catch (err) {
      setError(normalizeEnrollmentError(err).message)
    } finally {
      setSubmitting(false)
    }
  }

  // Two-button states: not-connected → open RainbowKit; connected → trigger sign.
  // We intentionally do not auto-fire the sign after connect; the user explicitly clicks twice
  // so the wallet prompts (connect + sign) don't feel chained or surprising.
  const submittingLabel = warming ? 'Warming up engine…' : 'Waiting for signature…'
  const primaryLabel = isConnected
    ? submitting
      ? submittingLabel
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
        Your privacy keys are derived from a signature your EVM wallet produces against a fixed
        message. The signing prompt explains that this is <strong>not a transaction</strong> — no
        funds move, no chain state changes.
      </p>
      {!isConnected ? (
        <p className={styles.bodyMuted}>
          Connect your EVM wallet to continue. Your signature stays in this browser — Armada
          never receives your private key.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {engine.state === 'failed' ? (
        <button
          type="button"
          className={styles.retryLink}
          disabled={submitting || retryingEngine}
          onClick={async () => {
            setRetryingEngine(true)
            setError(null)
            try {
              await retryRailgunEngineInit()
            } catch (err) {
              setError(normalizeEnrollmentError(err).message)
            } finally {
              setRetryingEngine(false)
            }
          }}
        >
          {retryingEngine ? 'Retrying engine setup…' : 'Retry engine setup'}
        </button>
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
