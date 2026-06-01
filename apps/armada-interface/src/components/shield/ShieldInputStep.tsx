// ABOUTME: Shield input step — From-chain selector, amount input (display variant), fee summary, Cancel + Continue.
// ABOUTME: Validates amount > 0 and amount <= max; disables Continue until valid.

import { AmountInput, ChainSelect, FeeSummary } from '@/components/ui'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { formatUsdc, parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { getNetworkConfig } from '@/config/network'
import styles from './ShieldInputStep.module.css'

export interface ShieldInputStepProps {
  fromChainId: number
  onFromChainIdChange: (chainId: number) => void
  amountStr: string
  onAmountChange: (next: string) => void
  /** Maximum amount (raw 6-decimal USDC) — sourced from useBalances().unshielded[fromChainId]. */
  max: bigint
  /**
   * Minimum valid amount (raw 6-decimal USDC). For gasless paths this is the relayer fee — the
   * wrapper would otherwise underflow on `shieldAmount = totalAmount - fee` when amount ≤ fee.
   * Zero for paths with no per-tx relayer fee (direct hub shield). The validator requires
   * strictly greater so amount == fee (which would shield zero) is also rejected.
   */
  minAmount: bigint
  fee: bigint | null
  netAmount: bigint
  isFeeRefreshing?: boolean
  onCancel: () => void
  onContinue: () => void
}

export function ShieldInputStep({
  fromChainId,
  onFromChainIdChange,
  amountStr,
  onAmountChange,
  max,
  minAmount,
  fee,
  netAmount,
  isFeeRefreshing,
  onCancel,
  onContinue,
}: ShieldInputStepProps) {
  const hubChainId = getNetworkConfig().hub.chainId
  const isXchain = fromChainId !== hubChainId
  const { value: amount, error: amountError } = parseUsdcInput(amountStr)
  const tooMuch = amount > max
  // Below-fee check: only meaningful when there's a fee (minAmount > 0); the entered amount
  // must be strictly greater than the fee so `shieldAmount = amount - fee` is > 0 on-chain.
  const tooSmall = minAmount > 0n && amount > 0n && amount <= minAmount
  // Parser-side errors (too-many-decimals etc) take precedence over balance-bound errors —
  // a malformed value can't meaningfully be compared to max anyway. Surfaced via AmountInput.
  const errorMessage =
    usdcInputErrorMessage(amountError) ??
    (tooMuch ? 'Amount exceeds your available balance.' : undefined) ??
    (tooSmall ? `Amount must be greater than the relayer fee (${formatUsdc(minAmount)} USDC).` : undefined)
  const isValid = amount > 0n && !tooMuch && !tooSmall && !amountError

  return (
    <div className={styles.root}>
      <ChainSelect
        label="From"
        value={fromChainId}
        onChange={onFromChainIdChange}
      />
      {isXchain ? (
        <div className={styles.xchainNotice}>
          Cross-chain deposit takes ~30 seconds to a few minutes for the CCTP confirmation. You
          can close this modal — progress is tracked in your activity history.
        </div>
      ) : null}
      <AmountInput
        variant="display"
        label="How much USDC?"
        value={amountStr}
        onValueChange={onAmountChange}
        max={max}
        error={errorMessage}
      />
      <FeeSummary
        fee={fee}
        netAmount={netAmount}
        netLabel="You'll deposit"
        isRefreshing={isFeeRefreshing}
      />
      <FlowFooter
        className={styles.footer}
        primary={{ label: 'Continue', onClick: onContinue, disabled: !isValid }}
        secondary={{ label: 'Cancel', onClick: onCancel }}
      />
    </div>
  )
}
