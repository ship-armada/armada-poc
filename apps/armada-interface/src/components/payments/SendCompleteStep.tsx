// ABOUTME: Send/Withdraw complete step — serif "Send confirmed"/"Withdrawal complete" title, USDC coin + amount block, shared TransferReviewSummary (with date/time), and explorer/dashboard CTAs.
// ABOUTME: Mirrors the send-confirmed reference — no divider between the summary card and the button row.

import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { Button } from '@/design'
import { TransferReviewSummary } from './TransferReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import type { SendFlowVariant } from './SendRecipientStep'
import styles from './SendCompleteStep.module.css'

const TOKEN_BADGE_PX = 40
/** @web3icons branded assets use an 18px circle in a 24px viewBox — scale up to fill the badge. */
const TOKEN_ICON_SIZE = Math.round((TOKEN_BADGE_PX * 24) / 18)

export interface SendCompleteStepProps {
  variant: SendFlowVariant
  recipient: string
  /** The user's own shielded (Armada) address — rendered as the summary's "From your private account" row. */
  armadaAddress?: string
  /** Gross amount sent/withdrawn (raw 6-decimal USDC) — shown full-precision in the coin block. */
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
  const title = variant === 'withdraw' ? 'Withdrawal complete' : 'Send confirmed'

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
        confirmedAt={confirmedAt}
      />

      <div className={styles.buttonRow}>
        <Button
          variant="secondary"
          size="lg"
          label="View on explorer"
          showIcon={false}
          onClick={onViewExplorer}
          disabled={!explorerUrl}
        />
        <Button
          variant="primary"
          size="lg"
          label="Go to dashboard"
          showIcon={false}
          onClick={onGoToDashboard}
        />
      </div>
    </div>
  )
}
