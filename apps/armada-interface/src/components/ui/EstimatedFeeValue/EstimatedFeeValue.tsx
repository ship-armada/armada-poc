// ABOUTME: Estimated fee display with optional loading state and fee-breakdown tooltip.

import { formatUsdcAmount } from '@/lib/format'
import type { DisplayFees } from '@/lib/fees/displayFees'
import { FeeBreakdownTooltip } from '@/components/ui/FeeBreakdownTooltip'
import styles from './EstimatedFeeValue.module.css'

export interface EstimatedFeeValueProps {
  fees: DisplayFees | null
  isLoading?: boolean
}

export function EstimatedFeeValue({ fees, isLoading = false }: EstimatedFeeValueProps) {
  if (isLoading || fees === null) {
    return <span className={styles.value}>Loading…</span>
  }

  const label =
    fees.totalFee === 0n ? 'No fee' : `${formatUsdcAmount(fees.totalFee)} USDC`

  return (
    <span className={styles.row}>
      <span className={styles.value}>{label}</span>
      <FeeBreakdownTooltip fees={fees} />
    </span>
  )
}
