// ABOUTME: Send/Withdraw complete step — frost card with left-aligned "USDC send/unshield confirmed" title + big mono amount, shared TransferReviewSummary (with date/time), and explorer/dashboard CTAs.
// ABOUTME: Mirrors ShieldCompleteStep — no divider between the summary card and the button row.

import { Button } from '@/design'
import { TransferReviewSummary } from './TransferReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import type { SendFlowVariant } from './SendRecipientStep'
import styles from './SendCompleteStep.module.css'

export interface SendCompleteStepProps {
  variant: SendFlowVariant
  recipient: string
  /** The user's own shielded (Armada) address — rendered as the summary's "From your private account" row. */
  armadaAddress?: string
  /** Gross amount sent/withdrawn (raw 6-decimal USDC) — shown full-precision in the amount block. */
  amount: bigint
  /** Inclusive Fee total — broadcaster + protocol + CCTP. Rendered as "—" when null. */
  fee: bigint | null
  /** USDC deducted from the user's shielded balance — `amount + fee`; the summary's Total row. */
  totalDeducted: bigint
  /** Destination chain name — shown on the summary's Network row for public (0x) recipients. */
  networkName?: string
  /** Wallet provider name for a public recipient's brand glyph (only when it's the user's own wallet). */
  recipientWalletProvider?: string
  /** Completion timestamp (ms) — drives the summary's "Date and time" row. */
  confirmedAt: number
  /** Source-chain explorer URL for the tx; absent disables the "View on explorer" button. */
  explorerUrl?: string
  onViewExplorer: () => void
  onGoToDashboard: () => void
}

export function SendCompleteStep({
  variant,
  recipient,
  armadaAddress,
  amount,
  fee,
  totalDeducted,
  networkName,
  recipientWalletProvider,
  confirmedAt,
  explorerUrl,
  onViewExplorer,
  onGoToDashboard,
}: SendCompleteStepProps) {
  const title = variant === 'withdraw' ? 'USDC unshield confirmed' : 'USDC send confirmed'

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
        confirmedAt={confirmedAt}
      />

      <div className={styles.buttonRow}>
        <Button
          variant="secondary"
          size="lg"
          label="View on explorer"
          showIcon={false}
          className={styles.cancelButton}
          onClick={onViewExplorer}
          disabled={!explorerUrl}
        />
        <Button
          variant="primary"
          size="lg"
          label="Go to dashboard"
          showIcon={false}
          className={styles.confirmButton}
          onClick={onGoToDashboard}
        />
      </div>
    </div>
  )
}
