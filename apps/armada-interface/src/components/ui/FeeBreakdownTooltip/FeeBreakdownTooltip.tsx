// ABOUTME: Info icon (16px) with rich tooltip — protocol fee (USDC), network gas (native token),
// ABOUTME: optional broadcaster fee + "you'll receive / total deducted" lines from computeFeeBreakdown.

import { InformationCircleIcon } from '@heroicons/react/16/solid'
import { formatUsdcAmount } from '@/lib/format'
import type { DisplayFees } from '@/lib/fees/displayFees'
import { Tooltip } from '@/components/ui/Tooltip'
import styles from './FeeBreakdownTooltip.module.css'

function formatUsdcLine(label: string, amount: bigint): string {
  // 0n → placeholder so a fresh-open tooltip (no amount entered yet) shows "-" instead of
  // "No fee", which reads as a claim about the fee schedule rather than a pre-input state.
  if (amount === 0n) return `${label}: -`
  // Sub-cent values format to "0.00" with our 2-decimal default — surface a clear "less than
  // a cent" hint instead so the user doesn't mis-read it as zero.
  const formatted = formatUsdcAmount(amount)
  if (formatted === '0.00') return `${label}: <0.01 USDC`
  return `${label}: ${formatted} USDC`
}

function formatGasLine(fees: DisplayFees): string {
  const gas = fees.nativeGas
  if (!gas) return 'Network gas: Paid in native token (e.g. ETH)'
  const trimmed = gas.formatted.replace(/(\.\d{4})\d+$/, '$1')
  return `Network gas: ~${trimmed} ${gas.symbol}`
}

/**
 * Optional flow-level breakdown layered onto the protocol-fee/native-gas tooltip. Provides the
 * shape our relayer-mediated / gasless flows need: the broadcaster fee that reimburses the
 * relayer's on-chain gas (paid in USDC), plus the resolved recipient-side and user-side totals
 * from `computeFeeBreakdown`. Pure presentational — DepositAmountCard forwards this in modals
 * where the user benefits from seeing the post-fee numbers without inline FeeSummary rows.
 */
export interface FlowFeeBreakdown {
  /** USDC broadcaster fee — reimburses relayer for submitting on-chain. 0n on direct flows. */
  broadcasterFee?: bigint
  /** Final amount the recipient (or shielded pool) receives. */
  recipientReceives?: bigint
  /** What ends up debited from the user's USDC balance. */
  totalDeducted?: bigint
  /** Recipient-side label — "You'll deposit", "Recipient receives", "Vault receives", etc. */
  recipientLabel?: string
}

export interface FeeBreakdownTooltipProps {
  fees: DisplayFees
  isLoading?: boolean
  flowBreakdown?: FlowFeeBreakdown
}

export function FeeBreakdownTooltip({
  fees,
  isLoading = false,
  flowBreakdown,
}: FeeBreakdownTooltipProps) {
  const broadcasterFee = flowBreakdown?.broadcasterFee ?? 0n
  const description =
    broadcasterFee > 0n
      ? "Protocol fee + relayer fee come out of your USDC. Network gas is paid by the relayer (you don't pay native gas)."
      : 'Protocol fee is taken from your deposit in USDC. Network gas is paid separately from your wallet.'

  const bullets: string[] = isLoading
    ? ['Loading fee estimate…']
    : [
        formatUsdcLine('Protocol fee', fees.protocolFee),
        ...(broadcasterFee > 0n ? [formatUsdcLine('Relayer fee', broadcasterFee)] : []),
        ...(broadcasterFee > 0n ? [] : [formatGasLine(fees)]),
        ...(flowBreakdown?.recipientLabel && flowBreakdown.recipientReceives !== undefined
          ? [formatUsdcLine(flowBreakdown.recipientLabel, flowBreakdown.recipientReceives)]
          : []),
        ...(flowBreakdown?.totalDeducted !== undefined &&
        flowBreakdown.recipientReceives !== flowBreakdown.totalDeducted
          ? [formatUsdcLine('Total deducted', flowBreakdown.totalDeducted)]
          : []),
        ...(fees.feeInclusive && fees.protocolFee > 0n && broadcasterFee === 0n
          ? ['Protocol fee is deducted from your deposit amount']
          : []),
      ]

  return (
    <Tooltip
      variant="rich"
      title="Fee breakdown"
      description={description}
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
