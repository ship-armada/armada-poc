// ABOUTME: Info icon (16px) with rich tooltip — protocol fee (USDC), network gas (native token).

import { InformationCircleIcon } from '@heroicons/react/16/solid'
import { formatUsdcAmount } from '@/lib/format'
import type { DisplayFees } from '@/lib/fees/displayFees'
import { Tooltip } from '@/components/ui/Tooltip'
import styles from './FeeBreakdownTooltip.module.css'

function formatUsdcLine(label: string, amount: bigint): string {
  if (amount === 0n) return `${label}: No fee`
  return `${label}: ${formatUsdcAmount(amount)} USDC`
}

function formatGasLine(fees: DisplayFees): string {
  const gas = fees.nativeGas
  if (!gas) return 'Network gas: Paid in native token (e.g. ETH)'
  const trimmed = gas.formatted.replace(/(\.\d{4})\d+$/, '$1')
  return `Network gas: ~${trimmed} ${gas.symbol}`
}

export interface FeeBreakdownTooltipProps {
  fees: DisplayFees
  isLoading?: boolean
}

export function FeeBreakdownTooltip({ fees, isLoading = false }: FeeBreakdownTooltipProps) {
  const bullets: string[] = isLoading
    ? ['Loading fee estimate…']
    : [
        formatUsdcLine('Protocol fee', fees.protocolFee),
        formatGasLine(fees),
        ...(fees.feeInclusive && fees.protocolFee > 0n
          ? ['Protocol fee is deducted from your deposit amount']
          : []),
      ]

  return (
    <Tooltip
      variant="rich"
      title="Fee breakdown"
      description="Protocol fee is taken from your deposit in USDC. Network gas is paid separately from your wallet."
      bullets={bullets}
    >
      <button
        type="button"
        className={styles.trigger}
        aria-label="Fee breakdown"
      >
        <InformationCircleIcon className={styles.iconMicro} aria-hidden />
      </button>
    </Tooltip>
  )
}
