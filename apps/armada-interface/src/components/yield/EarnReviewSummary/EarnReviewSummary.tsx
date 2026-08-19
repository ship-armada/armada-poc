// ABOUTME: EarnReviewSummary — transparent vault summary table (mode / APY / amount / fees) with a per-tab total row.
// ABOUTME: Shares DepositReviewSummary's CSS so the rows sit inside the review/complete frost card; confirmedAt adds a "Date and time" row.

import { formatTransactionDateTime, formatUsdcAmount } from '@/lib/format'
import { rateToApy } from '@/lib/yield'
import type { YieldRate } from '@/hooks/useYieldRate'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import type { EarnTab } from '../EarnInputStep'
import styles from '../../deposit/DepositReviewSummary/DepositReviewSummary.module.css'

export interface EarnReviewSummaryProps {
  tab: EarnTab
  /** Requested USDC (raw 6-decimal) — the deposit or withdrawal amount. */
  amount: bigint
  /** Vault rate snapshot — drives the "Estimated APY" row. */
  rate: YieldRate | null
  /** Inclusive fee total — broadcaster + protocol. Rendered as "—" when null (pre-quote-load). */
  fee: bigint | null
  /**
   * Bottom-line USDC number, computed per-tab by the modal. For Add this is the private-balance
   * debit (`amount + fee`); for Withdraw it's the net private-balance gain (`amount`, with the fee
   * paid as a separate proof leg). NOT a blind `amount + fee` — the two tabs' balance flows differ.
   */
  netAmount: bigint
  /** Label paired with `netAmount` — also per-tab from the modal. */
  netLabel: string
  /** Completion timestamp (ms) — when present, adds a leading "Date and time" row for confirmations. */
  confirmedAt?: number
}

function formatApy(rate: YieldRate | null): string {
  if (!rate) return 'syncing…'
  const apy = rateToApy(rate.apyBps)
  if (apy === 0) return 'unavailable'
  return `~${apy.toFixed(2)}%`
}

export function EarnReviewSummary({
  tab,
  amount,
  rate,
  fee,
  netAmount,
  netLabel,
  confirmedAt,
}: EarnReviewSummaryProps) {
  const modeLabel = tab === 'add' ? 'Add to vault' : 'Withdraw from vault'
  const amountLabel = tab === 'add' ? 'Your deposit' : 'Your withdrawal'
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
          <span className={styles.summaryLabel}>Mode</span>
          <span className={styles.summaryValue}>{modeLabel}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Estimated APY</span>
          <span className={styles.summaryValue}>{formatApy(rate)}</span>
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
      {/* Total row is the modal's per-tab net figure — deposit debits `amount + fee`; withdraw
          returns `amount` in full (fee paid on a separate leg). Not a generic `amount + fee`. */}
      <div className={styles.summaryTotalRow}>
        <span className={styles.summaryTotalLabel}>{netLabel}</span>
        <span className={[styles.summaryTotalValue, usdcAmount.font].join(' ')}>
          {formatUsdcAmount(netAmount)} USDC
        </span>
      </div>
    </div>
  )
}
