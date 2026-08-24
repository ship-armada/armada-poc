// ABOUTME: Send/Withdraw amount step — DepositAmountCard (no chain row; chosen on the recipient step) + percent pills + gas notice.
// ABOUTME: Recipient + chain live on the preceding recipient step, so this step gates only on the amount.

import { useMemo, useRef, type Ref } from 'react'
import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { DepositAmountCard } from '@/components/deposit/DepositAmountCard/DepositAmountCard'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { GasBalanceNotice } from '@/components/ui'
import { useNudgeShake } from '@/hooks/useNudgeShake'
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
  /** Ref onto the amount input so the footer's incomplete-CTA nudge can focus the field. */
  inputRef?: Ref<HTMLInputElement>
  /** Called when the disabled "Input amount" CTA is tapped — focuses the amount field alongside the shake. */
  onIncompleteContinue?: () => void
  /** One-shot shake on the amount card — the incomplete-CTA nudge (owned by the modal). */
  shaking?: boolean
  /** Clears the shake once its animation ends; wire to `useNudgeShake().onShakeAnimationEnd`. */
  onShakeAnimationEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void
}

export function SendInputStepContent({
  variant,
  destChainId,
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
  inputRef,
  shaking = false,
  onShakeAnimationEnd,
}: Pick<
  SendInputStepProps,
  | 'variant'
  | 'destChainId'
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
  | 'inputRef'
  | 'shaking'
  | 'onShakeAnimationEnd'
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
    ?? (tooMuch ? "That's more than you can send" : undefined)

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
          balanceRaw={max}
          onMax={() => onAmountChange(formatUsdcPlain(maxInput))}
          error={amountError}
          amountAriaLabel={variant === 'withdraw' ? 'Withdrawal amount' : 'Send amount'}
          inputRef={inputRef}
          shaking={shaking}
          onShakeAnimationEnd={onShakeAnimationEnd}
        />
        {showGasNotice ? (
          <GasBalanceNotice
            nativeSymbol={gasWarning.nativeSymbol}
            formattedBalance={gasWarning.formattedBalance}
          />
        ) : null}
      </div>
    </div>
  )
}

export function SendInputStepFooter({
  amountStr,
  maxInput,
  onBack,
  onContinue,
  onIncompleteContinue,
}: Pick<
  SendInputStepProps,
  'amountStr' | 'maxInput' | 'onBack' | 'onContinue' | 'onIncompleteContinue'
>) {
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
        label={canReview ? 'Review' : 'Input amount'}
        showIcon={false}
        disabled={!canReview}
        onClick={onContinue}
        // Tapping the incomplete CTA nudges (shake the amount card) + focuses the field — the modal
        // owns useNudgeShake and folds nudge() into onIncompleteContinue.
        onDisabledClick={() => onIncompleteContinue?.()}
      />
    </div>
  )
}

export function SendInputStep(props: SendInputStepProps) {
  // The step is the common parent of the amount card + footer, so it owns the ref + nudge shared
  // between them (the modals render Content/Footer directly and own their own; this covers standalone use).
  const amountInputRef = useRef<HTMLInputElement>(null)
  const { shaking, nudge, onShakeAnimationEnd } = useNudgeShake()
  return (
    <>
      <SendInputStepContent
        {...props}
        inputRef={amountInputRef}
        shaking={shaking}
        onShakeAnimationEnd={onShakeAnimationEnd}
      />
      <SendInputStepFooter
        {...props}
        onIncompleteContinue={() => {
          nudge()
          amountInputRef.current?.focus()
        }}
      />
    </>
  )
}
