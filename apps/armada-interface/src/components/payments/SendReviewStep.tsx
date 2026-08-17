// ABOUTME: Send/Withdraw review step — serif title, USDC coin + full-precision amount block, shared TransferReviewSummary table, Confirm/Back CTAs.
// ABOUTME: Delegates the summary rows (network, private account, recipient, privacy, amount, fees, total) to TransferReviewSummary; keeps the sync-gate notice + submit disabling.

import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { Button } from '@/design'
import { TransferReviewSummary } from './TransferReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import type { SendFlowVariant } from './SendRecipientStep'
import styles from './SendReviewStep.module.css'

const TOKEN_BADGE_PX = 40
/** @web3icons branded assets use an 18px circle in a 24px viewBox — scale up to fill the badge. */
const TOKEN_ICON_SIZE = Math.round((TOKEN_BADGE_PX * 24) / 18)

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
  const title = variant === 'withdraw' ? 'Review your withdrawal' : 'Review transfer'
  const confirmLabel = variant === 'withdraw' ? 'Confirm withdrawal' : 'Confirm send'

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>{title}</h1>

      <div className={styles.amountRow}>
        <div className={styles.amountGroup}>
          <span className={styles.tokenBadge} aria-hidden="true">
            <TokenUSDC size={TOKEN_ICON_SIZE} variant="branded" className={styles.tokenBadgeIcon} />
          </span>
          <span className={[styles.amountValue, usdcAmount.font].join(' ')}>
            {formatUsdcPlain(amount)}
          </span>
        </div>
      </div>

      <TransferReviewSummary
        recipient={recipient}
        armadaAddress={armadaAddress}
        amount={amount}
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
        <Button variant="secondary" size="lg" label="Back" showIcon={false} onClick={onBack} />
        <Button
          variant="primary"
          size="lg"
          label={confirmLabel}
          showIcon={false}
          onClick={onConfirm}
          disabled={Boolean(submitBlockedReason) || isSubmitting}
        />
      </div>
    </div>
  )
}
