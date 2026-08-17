// ABOUTME: TransferReviewSummary — borderless send/withdraw summary table (network / private account / recipient / privacy / amount / fees) with a fee-on-top "Total" row.
// ABOUTME: Shared by SendReviewStep and SendCompleteStep; an optional confirmedAt adds a leading "Date and time" row for confirmations.

import { ArmadaLogo } from '@/design'
import { WalletProviderIcon } from '@/components/ui/WalletProviderIcon'
import { formatTransactionDateTime, formatUsdcAmount, truncateAddress } from '@/lib/format'
import { isShieldedAddress } from '@/lib/address'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import type { SendFlowVariant } from '../SendRecipientStep'
import styles from './TransferReviewSummary.module.css'

const ROW_ICON_PX = 16

export interface TransferReviewSummaryProps {
  /** Destination address (0zk shielded or 0x public) — its format drives the privacy row + recipient icon. */
  recipient: string
  /** The user's own shielded (Armada) address — rendered (truncated) as the "From your private account" row when present. */
  armadaAddress?: string
  /** Gross amount sent/withdrawn (raw 6-decimal USDC). */
  amount: bigint
  /** Inclusive fee total — broadcaster + protocol + CCTP. Rendered as "—" when null (pre-quote-load). */
  fee: bigint | null
  /** USDC deducted from the user's shielded balance. Fee-on-top, so this is `amount + fee`. */
  totalDeducted: bigint
  variant: SendFlowVariant
  /** Destination chain name — rendered on the "Network" row for public (0x) recipients only. */
  networkName?: string
  /**
   * Wallet provider name (wagmi connector) to brand a public (0x) recipient's row glyph. Passed
   * only when the recipient is the user's own connected wallet (e.g. withdraw-to-self) — for an
   * arbitrary recipient it's omitted and a generic wallet glyph is shown instead. Matches the
   * deposit flow's "From your wallet" treatment. Ignored for private (0zk) recipients.
   */
  recipientWalletProvider?: string
  /** Completion timestamp (ms) — when present, adds a leading "Date and time" row for confirmations. */
  confirmedAt?: number
}

export function TransferReviewSummary({
  recipient,
  armadaAddress,
  amount,
  fee,
  totalDeducted,
  variant,
  networkName,
  recipientWalletProvider,
  confirmedAt,
}: TransferReviewSummaryProps) {
  // Private (0zk → 0zk) transfers stay inside the shielded pool; anything else exits to a public
  // wallet. Drives the privacy row, the recipient-row icon, and whether the network row shows.
  const isPrivate = isShieldedAddress(recipient)
  const amountLabel = variant === 'withdraw' ? 'Withdrawal amount' : 'Send amount'
  return (
    <div className={styles.summary}>
      <div className={styles.summaryBody}>
        {confirmedAt !== undefined ? (
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Date and time</span>
            <span className={styles.summaryValue}>{formatTransactionDateTime(confirmedAt)}</span>
          </div>
        ) : null}
        {/* Network only applies to a public unshield to a specific chain — a private transfer has
            no destination-chain concept, so the row is omitted. */}
        {!isPrivate && networkName ? (
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Network</span>
            <span className={styles.summaryValue}>{networkName}</span>
          </div>
        ) : null}
        {armadaAddress ? (
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>From your private account</span>
            <span className={styles.summaryValue}>
              <span className={styles.valueWithIcon}>
                <ArmadaLogo variant="mark" className={styles.armadaIcon} />
                <span>{truncateAddress(armadaAddress)}</span>
              </span>
            </span>
          </div>
        ) : null}
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>To recipient</span>
          <span className={styles.summaryValue}>
            <span className={styles.valueWithIcon}>
              {/* A private (0zk) recipient carries the Armada mark; a public wallet address carries
                  a wallet-provider glyph (brand when it's the user's own wallet, else generic) —
                  mirroring the deposit flow's "From your wallet" row. */}
              {isPrivate ? (
                <ArmadaLogo variant="mark" className={styles.armadaIcon} />
              ) : (
                <WalletProviderIcon provider={recipientWalletProvider} size={ROW_ICON_PX} />
              )}
              <span>{truncateAddress(recipient)}</span>
            </span>
          </span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Privacy</span>
          <span className={styles.summaryValue}>{isPrivate ? 'Private' : 'Public'}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>{amountLabel}</span>
          <span className={[styles.summaryValue, usdcAmount.font].join(' ')}>
            {formatUsdcAmount(amount)} USDC
          </span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Fees</span>
          <span className={[styles.summaryValue, usdcAmount.font].join(' ')}>
            {fee === null ? '—' : `${formatUsdcAmount(fee)} USDC`}
          </span>
        </div>
      </div>
      {/* Send/withdraw fees are fee-on-top: the shielded balance is charged `amount + fee`, so the
          total is the full deduction (not a net "you'll receive" figure like the deposit flow). */}
      <div className={styles.summaryTotalRow}>
        <span className={styles.summaryTotalLabel}>Total</span>
        <span className={[styles.summaryTotalValue, usdcAmount.font].join(' ')}>
          {formatUsdcAmount(totalDeducted)} USDC
        </span>
      </div>
    </div>
  )
}
