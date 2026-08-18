// ABOUTME: Shield amount step — DepositAmountCard + Review/Cancel CTAs (full-viewport deposit flow).
// ABOUTME: gaslessMode hides the GasBalanceNotice on the relayer-mediated permit path; the wallet-submit fallback shows it when the wallet's native balance is low.

import { useMemo } from 'react'
import { Button } from '@/design'
import { DepositAmountCard } from '@/components/deposit/DepositAmountCard/DepositAmountCard'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { GasBalanceNotice } from '@/components/ui'
import type { FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import { getAllChainIdentities } from '@/config/network'
import { formatUsdcPlain, parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import type { DisplayFees } from '@/lib/fees/displayFees'
import { useGasBalanceWarning } from '@/hooks/useGasBalanceWarning'
import { hasActiveAmount } from '@/utils/amountInput'
import styles from './ShieldInputStep.module.css'

export interface ShieldInputStepProps {
  fromChainId: number
  onFromChainIdChange: (chainId: number) => void
  amountStr: string
  onAmountChange: (next: string) => void
  /** Raw unshielded balance shown on the card's balance row. */
  max: bigint
  /** Cap accepted by the amount input — reserves fee on top for `fee-on-top` paths. */
  maxInput: bigint
  /** Minimum valid amount (raw 6-decimal USDC) — relayer fee for gasless paths so `shieldAmount = amount - fee > 0`. Zero for paths with no per-tx relayer fee. */
  minAmount: bigint
  displayFees: DisplayFees
  flowBreakdown?: FlowFeeBreakdown
  feeLoading?: boolean
  /**
   * When true, submission goes through the gasless permit + wrapper path — the user pays no
   * native gas, so the GasBalanceNotice is suppressed. When false the user's wallet submits
   * directly and needs native gas; the notice shows when the wallet's native balance is below
   * the safety floor in `useGasBalanceWarning`.
   */
  gaslessMode?: boolean
  onCancel: () => void
  onContinue: () => void
}

type ContentProps = Pick<
  ShieldInputStepProps,
  | 'fromChainId'
  | 'onFromChainIdChange'
  | 'amountStr'
  | 'onAmountChange'
  | 'max'
  | 'maxInput'
  | 'minAmount'
  | 'displayFees'
  | 'flowBreakdown'
  | 'feeLoading'
  | 'gaslessMode'
>

export function ShieldInputStepContent({
  fromChainId,
  onFromChainIdChange,
  amountStr,
  onAmountChange,
  max,
  maxInput,
  minAmount,
  displayFees,
  flowBreakdown,
  feeLoading = false,
  gaslessMode = true,
}: ContentProps) {
  const chains = useMemo(
    () => getAllChainIdentities().map((c) => ({ chainId: c.chainId, label: c.name })),
    [],
  )
  const gasWarning = useGasBalanceWarning(fromChainId)
  const showGasNotice = !gaslessMode && gasWarning.show

  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  // Below-fee check: only meaningful when there's a fee (minAmount > 0); the entered amount
  // must be strictly greater than the fee so `shieldAmount = amount - fee` is > 0 on-chain.
  const tooSmall = minAmount > 0n && amount > 0n && amount <= minAmount
  const errorMessage =
    usdcInputErrorMessage(parseError) ??
    (tooMuch ? 'Amount exceeds your available balance.' : undefined) ??
    (tooSmall
      ? `Amount must be greater than the relayer fee (${formatUsdcPlain(minAmount)} USDC).`
      : undefined)

  const balanceDisplay = formatUsdcPlain(max)

  return (
    <div className={styles.contentZone}>
      <h1 className={styles.title}>Shield your USDC</h1>
      <DepositAmountCard
        chains={chains}
        chainId={fromChainId}
        onChainIdChange={onFromChainIdChange}
        amount={amountStr}
        onAmountChange={onAmountChange}
        balance={balanceDisplay}
        displayFees={displayFees}
        flowBreakdown={flowBreakdown}
        feeLoading={feeLoading}
        onMax={() => onAmountChange(formatUsdcPlain(maxInput))}
        maxInput={maxInput}
        error={errorMessage}
        amountAriaLabel="Deposit amount"
      />
      {showGasNotice ? (
        <GasBalanceNotice
          nativeSymbol={gasWarning.nativeSymbol}
          formattedBalance={gasWarning.formattedBalance}
        />
      ) : null}
    </div>
  )
}

type FooterProps = Pick<
  ShieldInputStepProps,
  'amountStr' | 'maxInput' | 'minAmount' | 'onCancel' | 'onContinue'
>

export function ShieldInputStepFooter({
  amountStr,
  maxInput,
  minAmount,
  onCancel,
  onContinue,
}: FooterProps) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const tooSmall = minAmount > 0n && amount > 0n && amount <= minAmount
  const canReview = hasActiveAmount(amountStr) && !tooMuch && !tooSmall && !parseError

  return (
    <div className={depositOverlayShellStyles.buttonRow}>
      <Button
        variant="secondary"
        size="lg"
        label="Cancel"
        showIcon={false}
        onClick={onCancel}
      />
      <Button
        variant="primary"
        size="lg"
        label="Review"
        showIcon={false}
        disabled={!canReview}
        onClick={onContinue}
      />
    </div>
  )
}

export function ShieldInputStep(props: ShieldInputStepProps) {
  return (
    <>
      <ShieldInputStepContent {...props} />
      <ShieldInputStepFooter {...props} />
    </>
  )
}
