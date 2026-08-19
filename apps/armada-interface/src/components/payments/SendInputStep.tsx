// ABOUTME: Send/Withdraw amount step — DepositAmountCard (no chain row; chosen on the recipient step) + percent pills + gas notice.
// ABOUTME: Recipient + chain live on the preceding recipient step, so this step gates only on the amount.

import { useMemo } from 'react'
import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { DepositAmountCard } from '@/components/deposit/DepositAmountCard/DepositAmountCard'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { GasBalanceNotice } from '@/components/ui'
import type { DisplayFees } from '@/lib/fees/displayFees'
import type { FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import { useGasBalanceWarning } from '@/hooks/useGasBalanceWarning'
import { getAllChainIdentities } from '@/config/network'
import { formatUsdcPlain, parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { hasActiveAmount } from '@/utils/amountInput'
import type { SendFlowVariant } from './SendRecipientStep'
import styles from './SendInputStep.module.css'

export interface SendInputStepProps {
  variant: SendFlowVariant
  /** Destination chain — chosen on the recipient step; rendered statically here. */
  destChainId: number
  /** True when the resolved kind is a cross-chain unshield (public recipient off-hub). */
  isXchain: boolean
  amountStr: string
  onAmountChange: (next: string) => void
  max: bigint
  maxInput: bigint
  /** Not-yet-spendable ("pending") shielded USDC (raw). Shown as a "· X pending" suffix; excluded
   *  from `max`/Max. Omitted or 0 (e.g. local Anvil) → no suffix. */
  pending?: bigint
  displayFees: DisplayFees
  flowBreakdown?: FlowFeeBreakdown
  feeLoading?: boolean
  gasChainId: number
  /**
   * When true, the relayer pays gas — suppresses the GasBalanceNotice. All three SendModal
   * kinds (`transfer-shielded`, `unshield-local`, `unshield-xchain`) route through the relayer
   * by default; the user pays native gas only when they've toggled Preferences →
   * "Submit transactions from my wallet". Mirrors `ShieldModal`.
   */
  gaslessMode?: boolean
  onBack: () => void
  onContinue: () => void
}

export function SendInputStepContent({
  variant,
  destChainId,
  isXchain,
  amountStr,
  onAmountChange,
  max,
  maxInput,
  pending,
  displayFees,
  flowBreakdown,
  feeLoading = false,
  gasChainId,
  gaslessMode = true,
}: Pick<
  SendInputStepProps,
  | 'variant'
  | 'destChainId'
  | 'isXchain'
  | 'amountStr'
  | 'onAmountChange'
  | 'max'
  | 'maxInput'
  | 'pending'
  | 'displayFees'
  | 'flowBreakdown'
  | 'feeLoading'
  | 'gasChainId'
  | 'gaslessMode'
>) {
  const allChains = useMemo(
    () => getAllChainIdentities().map((c) => ({ chainId: c.chainId, label: c.name })),
    [],
  )

  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const gasWarning = useGasBalanceWarning(gasChainId)
  // Only surface the gas notice when the user actually pays gas themselves. All three SendModal
  // kinds default to the relayer path; the wallet-submit override flips `gaslessMode` to false.
  const showGasNotice = !gaslessMode && gasWarning.show
  const tooMuch = amount > maxInput
  const amountError = usdcInputErrorMessage(parseError)
    ?? (tooMuch ? 'Amount exceeds your private balance after fees.' : undefined)

  return (
    <div className={`${styles.sendContent} ${modalStepBodyEnter}`}>
      <div className={styles.amountGroup}>
        <DepositAmountCard
          chains={allChains}
          chainId={destChainId}
          // Title now lives inside the card; the chain is chosen on the recipient step (no chain row here).
          title="How much USDC?"
          showChain={false}
          amount={amountStr}
          onAmountChange={onAmountChange}
          balance={formatUsdcPlain(max)}
          pendingBalance={pending !== undefined && pending > 0n ? formatUsdcPlain(pending) : undefined}
          displayFees={displayFees}
          flowBreakdown={flowBreakdown}
          feeLoading={feeLoading}
          // maxInput drives the 25% / 50% / 75% / Max percent pills; onMax keeps the exact fee-aware cap.
          maxInput={maxInput}
          onMax={() => onAmountChange(formatUsdcPlain(maxInput))}
          error={amountError}
          amountAriaLabel={variant === 'withdraw' ? 'Withdrawal amount' : 'Send amount'}
        />
        {showGasNotice ? (
          <GasBalanceNotice
            nativeSymbol={gasWarning.nativeSymbol}
            formattedBalance={gasWarning.formattedBalance}
          />
        ) : null}
      </div>
      {isXchain ? (
        <div className={styles.xchainNotice}>
          Cross-chain payment takes a few minutes for the CCTP confirmation.
        </div>
      ) : null}
    </div>
  )
}

export function SendInputStepFooter({
  amountStr,
  maxInput,
  onBack,
  onContinue,
}: Pick<SendInputStepProps, 'amountStr' | 'maxInput' | 'onBack' | 'onContinue'>) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const canReview = hasActiveAmount(amountStr) && !tooMuch && !parseError

  return (
    <div className={`${depositOverlayShellStyles.buttonRow} ${modalActionRowEnter}`}>
      <Button
        variant="secondary"
        size="lg"
        label="Back"
        showIcon={false}
        onClick={onBack}
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

export function SendInputStep(props: SendInputStepProps) {
  return (
    <>
      <SendInputStepContent {...props} />
      <SendInputStepFooter {...props} />
    </>
  )
}
