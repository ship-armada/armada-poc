// ABOUTME: DepositReviewSummary — borderless deposit summary table (network / wallet / shielded account / amount / fees) with a "You'll receive" total.
// ABOUTME: Shared by ShieldReviewStep and ShieldCompleteStep; an optional confirmedAt adds a leading "Date and time" row for confirmations.

import { ArmadaLogo } from '@/design'
import { WalletProviderIcon } from '@/components/ui/WalletProviderIcon'
import { formatTransactionDateTime, formatUsdcAmount, truncateAddress } from '@/lib/format'
import { getChainById } from '@/config/network'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import styles from './DepositReviewSummary.module.css'

const ROW_ICON_PX = 16

export interface DepositReviewSummaryProps {
  fromChainId: number
  amount: bigint
  fee: bigint | null
  netAmount: bigint
  /** Connected EVM wallet address — rendered (truncated) as the "From your wallet" row when present. */
  walletAddress?: string
  /** Connected wallet provider name (wagmi connector) — drives the "From your wallet" brand glyph. */
  walletProvider?: string
  /** Shielded (Armada) destination address — rendered (truncated) as the "To your private account" row when present. */
  shieldedAddress?: string
  /** Completion timestamp (ms) — when present, adds a leading "Date and time" row for confirmations. */
  confirmedAt?: number
}

export function DepositReviewSummary({
  fromChainId,
  amount,
  fee,
  netAmount,
  walletAddress,
  walletProvider,
  shieldedAddress,
  confirmedAt,
}: DepositReviewSummaryProps) {
  const fromChain = getChainById(fromChainId)
  const feeValue = fee ?? 0n
  return (
    <div className={styles.summary}>
      <div className={styles.summaryBody}>
        {confirmedAt !== undefined ? (
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Date and time</span>
            <span className={styles.summaryValue}>{formatTransactionDateTime(confirmedAt)}</span>
          </div>
        ) : null}
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Network</span>
          <span className={styles.summaryValue}>
            {fromChain?.name ?? `Chain ${fromChainId}`}
          </span>
        </div>
        {walletAddress ? (
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>From your wallet</span>
            <span className={styles.summaryValue}>
              <span className={styles.valueWithIcon}>
                <WalletProviderIcon provider={walletProvider} size={ROW_ICON_PX} />
                <span>{truncateAddress(walletAddress)}</span>
              </span>
            </span>
          </div>
        ) : null}
        {shieldedAddress ? (
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>To your private account</span>
            <span className={styles.summaryValue}>
              <span className={styles.valueWithIcon}>
                <ArmadaLogo variant="mark" className={styles.armadaIcon} />
                <span>{truncateAddress(shieldedAddress)}</span>
              </span>
            </span>
          </div>
        ) : null}
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Deposit amount</span>
          <span className={[styles.summaryValue, usdcAmount.font].join(' ')}>
            {formatUsdcAmount(amount)} USDC
          </span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Fees</span>
          <span className={[styles.summaryValue, usdcAmount.font].join(' ')}>
            {fee === null ? '—' : `${formatUsdcAmount(feeValue)} USDC`}
          </span>
        </div>
      </div>
      {/* Deposit fees are inclusive: the wallet is charged `amount` and the shielded pool receives
          `amount - fees`. Show that net figure (not a fee-on-top total, which would overstate the charge). */}
      <div className={styles.summaryTotalRow}>
        {/* Past tense once confirmed (confirmedAt is only set on the confirmation step). */}
        <span className={styles.summaryTotalLabel}>
          {confirmedAt !== undefined ? 'You received' : "You'll receive"}
        </span>
        <span className={[styles.summaryTotalValue, usdcAmount.font].join(' ')}>
          {formatUsdcAmount(netAmount)} USDC
        </span>
      </div>
    </div>
  )
}
