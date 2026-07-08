// ABOUTME: Dedicated error screen rendered when signIn() detects a non-deterministic wallet — Path C routes users to backup/paste recovery rather than dead-ending.
// ABOUTME: Two CTAs: primary "Use a backup file or recovery secret" (routes to UnlockFlow); secondary "Try a different wallet" (disconnects + back to welcome).

import { Button, Text } from '@armada/ui'
import type { NonDeterministicSignerErrorReason } from '@/lib/crypto/determinism'
import styles from './NonDeterministicSignerScreen.module.css'

export interface NonDeterministicSignerScreenProps {
  /**
   * Why we're showing this screen. Drives the heading copy:
   *  - `first-sign-mismatch`: the double-sign verification produced two different
   *    signatures (typical for smart-account wallets, Safe, EIP-1271 contract
   *    signers, or wallets using random ECDSA `k`).
   *  - `cached-checksum-mismatch`: a returning sign-in derived a different
   *    identity than the one stored on this device. Less common; usually a
   *    wallet account switch the user didn't notice.
   */
  readonly reason: NonDeterministicSignerErrorReason
  /** Route to UnlockFlow with the paste/backup tabs available. */
  readonly onUseRecovery: () => void
  /**
   * Disconnect the EVM wallet and return to the entry screen. Caller is
   * responsible for the actual `wagmi` disconnect — this component just
   * surfaces the intent.
   */
  readonly onTryDifferentWallet: () => void
}

// Supported (deterministic) wallets and explicitly-unsupported wallet families. Pulled into
// constants so the determinism error copy stays in lock-step with the V2 amendment's compatibility
// list. When the list changes, this is the only spot that needs editing.
const SUPPORTED_WALLETS = [
  'MetaMask',
  'Rabby',
  'Frame',
  'Ledger (via MetaMask / Frame / Rabby)',
  'Trezor (via MetaMask / Frame)',
  'Coinbase Wallet',
] as const

const UNSUPPORTED_WALLETS = [
  'Safe / Gnosis Safe',
  'Other smart-account / ERC-4337 wallets',
  'Wallets using random ECDSA nonces (some older builds)',
] as const

function headlineFor(reason: NonDeterministicSignerErrorReason): string {
  switch (reason) {
    case 'first-sign-mismatch':
      return "This wallet can't unlock by signing"
    case 'cached-checksum-mismatch':
      return 'Your wallet now produces a different identity'
  }
}

function bodyFor(reason: NonDeterministicSignerErrorReason): string {
  switch (reason) {
    case 'first-sign-mismatch':
      return "Armada's sign-in needs a wallet that produces a consistent signature each time. This wallet appears to randomize signatures (or is a smart-account wallet), which sign-in can't use. New to Armada? Connect one of the supported wallets listed here to create your account — you don't need a backup yet. Already have an account? Unlock with your encrypted backup file or recovery secret."
    case 'cached-checksum-mismatch':
      return 'Re-signing with this wallet produces a different identity than the one this device is bound to. This often means your wallet has changed underlying accounts. Sign-in cannot recover the original identity here — unlock with your encrypted backup file or your recovery secret.'
  }
}

export function NonDeterministicSignerScreen({
  reason,
  onUseRecovery,
  onTryDifferentWallet,
}: NonDeterministicSignerScreenProps) {
  return (
    <div className={styles.root} role="alert">
      <Text variant="display-lg" as="h2" className={styles.title}>
        {headlineFor(reason)}
      </Text>
      <p className={styles.body}>{bodyFor(reason)}</p>

      <div className={styles.lists}>
        <section className={styles.list}>
          <Text variant="ui-label-xs" as="p" className={styles.listHeading}>
            Supported for sign-in
          </Text>
          <ul className={styles.listItems}>
            {SUPPORTED_WALLETS.map((w) => (
              <li key={w} className={styles.listItem}>
                <span className={styles.checkIcon} aria-hidden>✓</span>
                {w}
              </li>
            ))}
          </ul>
        </section>
        <section className={styles.list}>
          <Text variant="ui-label-xs" as="p" className={styles.listHeading}>
            Not supported for sign-in
          </Text>
          <ul className={styles.listItems}>
            {UNSUPPORTED_WALLETS.map((w) => (
              <li key={w} className={styles.listItem}>
                <span className={styles.crossIcon} aria-hidden>✗</span>
                {w}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className={styles.actions}>
        <Button
          variant="primary"
          size="md"
          label="Use a backup file or recovery secret"
          showIcon
          onClick={onUseRecovery}
        />
        <Button
          variant="ghost"
          size="md"
          label="Try a different wallet"
          showIcon={false}
          onClick={onTryDifferentWallet}
        />
      </div>
    </div>
  )
}
