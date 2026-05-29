// ABOUTME: FeeSummary — "Estimated fee" + "You'll receive/deposit" two-line panel for action flow input/review steps.
// ABOUTME: Generic: caller provides the fee (or null while loading) and net amount; FeeSummary handles formatting + loading state.

import { formatUsdcAmount } from '@/lib/format'
import styles from './FeeSummary.module.css'

/**
 * Format a positive USDC fee for the summary row. `formatUsdcAmount` clamps to 2 decimals, so
 * sub-cent fees (e.g. CCTP fast-fee on a $5 unshield is 0.001 USDC) display as "0.00 USDC" —
 * indistinguishable from a no-fee row even though the fee IS being applied on chain. Surface
 * "<0.01 USDC" in that range so the user sees something non-zero.
 *
 * The threshold is one cent: 10_000 raw with USDC's 6-decimal precision. Caller is responsible
 * for the `value > 0n` guard since we still want to render "No fee" for true zero.
 */
function formatFeeForRow(value: bigint): string {
  if (value < 10_000n) return '<0.01'
  return formatUsdcAmount(value)
}

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
              {formatFeeForRow(fee)} <span className={styles.unit}>USDC</span>
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
                {formatFeeForRow(secondaryFee)} <span className={styles.unit}>USDC</span>
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
