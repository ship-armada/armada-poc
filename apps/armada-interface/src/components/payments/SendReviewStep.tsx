// ABOUTME: Send/Withdraw review step — frost card with left-aligned UI title + big mono amount, shared TransferReviewSummary table, Confirm/Back CTAs.
// ABOUTME: Delegates the summary rows (date, private account, recipient, fees, total + privacy notice) to TransferReviewSummary; keeps the sync-gate notice + submit disabling.

import { Button } from '@/design'
import { TransferReviewSummary } from './TransferReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import type { SendFlowVariant } from './SendRecipientStep'
import styles from './SendReviewStep.module.css'

export interface SendReviewStepProps {
  variant: SendFlowVariant
  recipient: string
  /** The user's own shielded (Armada) address — rendered as the summary's "From your private account" row. */
  armadaAddress?: string
  amount: bigint
  /** Inclusive Fee total — broadcaster + protocol + CCTP. Tooltip breaks it down on the input card. */
  fee: bigint | null
  /** USDC deducted from the user's shielded balance — `amount + fee` across all three kinds. */
  totalDeducted: bigint
  /** Destination chain name — shown on the summary's Network row for public (0x) recipients. */
  networkName?: string
  /** Wallet provider name for a public recipient's brand glyph (only when it's the user's own wallet). */
  recipientWalletProvider?: string
  submitBlockedReason?: string | null
  /** True while a submit is in flight — disables Confirm so a double-click can't create two txs. */
  isSubmitting?: boolean
  onBack: () => void
  onConfirm: () => void
}

export function SendReviewStep({
  variant,
  recipient,
  armadaAddress,
  amount,
  fee,
  totalDeducted,
  networkName,
  recipientWalletProvider,
  submitBlockedReason,
  isSubmitting,
  onBack,
  onConfirm,
}: SendReviewStepProps) {
  const title = variant === 'withdraw' ? 'Review your USDC unshield' : 'Review your USDC transfer'
  const confirmLabel = variant === 'withdraw' ? 'Confirm' : 'Confirm send'

  return (
    <div className={styles.root}>
      <div className={styles.titleBlock}>
        <h1 className={styles.title}>{title}</h1>
        <div className={styles.amountRow}>
          <span className={styles.amountValue}>{formatUsdcPlain(amount)}</span>
        </div>
      </div>

      <TransferReviewSummary
        recipient={recipient}
        armadaAddress={armadaAddress}
        fee={fee}
        totalDeducted={totalDeducted}
        variant={variant}
        networkName={networkName}
        recipientWalletProvider={recipientWalletProvider}
      />

      {submitBlockedReason ? (
        <div className={styles.syncNotice} role="status" aria-live="polite">
          {submitBlockedReason}
        </div>
      ) : null}

      <div className={styles.buttonRow}>
        <Button
          variant="secondary"
          size="lg"
          label="Back"
          showIcon={false}
          className={styles.cancelButton}
          onClick={onBack}
        />
        <Button
          variant="primary"
          size="lg"
          label={confirmLabel}
          showIcon={false}
          className={styles.confirmButton}
          onClick={onConfirm}
          disabled={Boolean(submitBlockedReason) || isSubmitting}
        />
      </div>
    </div>
  )
}
