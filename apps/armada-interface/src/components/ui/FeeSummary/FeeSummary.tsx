// ABOUTME: FeeSummary — "Estimated fee" + "You'll receive/deposit" two-line panel for action flow input/review steps.
// ABOUTME: Generic: caller provides the fee (or null while loading) and net amount; FeeSummary handles formatting + loading state.

import { formatUsdcAmount } from '@/lib/format'
import styles from './FeeSummary.module.css'

export interface FeeSummaryProps {
  /** Estimated fee in raw 6-decimal USDC. null while a quote is being fetched. */
  fee: bigint | null
  /** Net amount the user receives or has credited (after fees), in raw 6-decimal USDC. */
  netAmount: bigint
  /** Label for the net amount line. Defaults to "You'll receive". */
  netLabel?: string
  /** Label for the fee line. Defaults to "Estimated fee". */
  feeLabel?: string
  /**
   * Optional second fee row — used when a flow has two fees with different semantics that the
   * user needs to see broken out (e.g., A5 unshield-xchain pays both a relayer broadcaster fee
   * and a CCTP delivery fee). Hidden when undefined or null.
   */
  secondaryFee?: bigint | null
  /** Label for the secondary fee row. Required if `secondaryFee` is set. */
  secondaryFeeLabel?: string
  /** Whether the fee quote is currently being refreshed; shows a subtle "refreshing…" hint. */
  isRefreshing?: boolean
  className?: string
}

export function FeeSummary({
  fee,
  netAmount,
  netLabel = "You'll receive",
  feeLabel = 'Estimated fee',
  secondaryFee,
  secondaryFeeLabel,
  isRefreshing,
  className,
}: FeeSummaryProps) {
  const cls = [styles.root, className].filter(Boolean).join(' ')
  const showSecondary = secondaryFee !== undefined && secondaryFee !== null && secondaryFeeLabel
  return (
    <dl className={cls}>
      <div className={styles.row}>
        <dt className={styles.label}>{feeLabel}</dt>
        <dd className={styles.value}>
          {fee === null ? (
            <span className={styles.loading}>Loading…</span>
          ) : fee === 0n ? (
            <span className={styles.zeroFee}>No fee</span>
          ) : (
            <>
              {formatUsdcAmount(fee)} <span className={styles.unit}>USDC</span>
            </>
          )}
          {isRefreshing && fee !== null && fee !== 0n ? (
            <span className={styles.refresh}> (refreshing)</span>
          ) : null}
        </dd>
      </div>
      {showSecondary ? (
        <div className={styles.row}>
          <dt className={styles.label}>{secondaryFeeLabel}</dt>
          <dd className={styles.value}>
            {secondaryFee === 0n ? (
              <span className={styles.zeroFee}>No fee</span>
            ) : (
              <>
                {formatUsdcAmount(secondaryFee)} <span className={styles.unit}>USDC</span>
              </>
            )}
          </dd>
        </div>
      ) : null}
      <div className={styles.divider} aria-hidden="true" />
      <div className={styles.row}>
        <dt className={styles.label}>{netLabel}</dt>
        <dd className={styles.valueEmphasis}>
          {formatUsdcAmount(netAmount)} <span className={styles.unit}>USDC</span>
        </dd>
      </div>
    </dl>
  )
}
