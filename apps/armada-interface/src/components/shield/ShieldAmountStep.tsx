// ABOUTME: Shared amount step for the Shield/Unshield tabbed modal — DepositAmountCard with the direction tabs in its header + a chain picker.
// ABOUTME: Direction-agnostic: the caller (ShieldModal) feeds it the active flow's values; footer gates Review on amount (+ shield's fee floor).

import { Button } from '@/design'
import { ChainSelect, GasBalanceNotice, SegmentedControl } from '@/components/ui'
import { DepositAmountCard } from '@/components/deposit/DepositAmountCard/DepositAmountCard'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import type { FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import type { DisplayFees } from '@/lib/fees/displayFees'
import { formatUsdcPlain, parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { useGasBalanceWarning } from '@/hooks/useGasBalanceWarning'
import { hasActiveAmount } from '@/utils/amountInput'
import styles from './ShieldAmountStep.module.css'

export type ShieldTab = 'shield' | 'unshield'

const SHIELD_TABS = [
  { id: 'shield' as const, label: 'Shield' },
  { id: 'unshield' as const, label: 'Unshield' },
]

interface ShieldAmountStepContentProps {
  tab: ShieldTab
  onTabChange: (tab: ShieldTab) => void
  /** Chain row: the source chain (shield) or destination chain (unshield). */
  chainId: number
  onChainIdChange: (chainId: number) => void
  amountStr: string
  onAmountChange: (next: string) => void
  /** Formatted spendable balance shown on the card's balance row. */
  balance: string
  /** Not-yet-spendable ("pending") shielded USDC (unshield only). */
  pendingBalance?: string
  /** Raw 6-decimal cap the amount input accepts (drives the % pills). */
  maxInput: bigint
  /** Minimum valid amount (shield's relayer-fee floor); 0n for unshield. Drives the inline error. */
  minAmount: bigint
  displayFees: DisplayFees
  flowBreakdown: FlowFeeBreakdown
  feeLoading?: boolean
  /** True when the relayer covers gas (shield gasless / unshield relayer). Suppresses the gas notice. */
  gaslessMode?: boolean
  /** Chain whose native balance is checked for the wallet-submit gas notice. */
  gasChainId: number
}

export function ShieldAmountStepContent({
  tab,
  onTabChange,
  chainId,
  onChainIdChange,
  amountStr,
  onAmountChange,
  balance,
  pendingBalance,
  maxInput,
  minAmount,
  displayFees,
  flowBreakdown,
  feeLoading = false,
  gaslessMode = true,
  gasChainId,
}: ShieldAmountStepContentProps) {
  const gasWarning = useGasBalanceWarning(gasChainId)
  const showGasNotice = !gaslessMode && gasWarning.show

  const isShield = tab === 'shield'
  const title = isShield ? 'Shield your USDC' : 'Unshield your USDC'
  const amountAriaLabel = isShield ? 'Deposit amount' : 'Unshield amount'

  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const tooSmall = minAmount > 0n && amount > 0n && amount <= minAmount
  const errorMessage =
    usdcInputErrorMessage(parseError) ??
    (tooMuch ? 'Amount exceeds your available balance.' : undefined) ??
    (tooSmall
      ? `Amount must be greater than the relayer fee (${formatUsdcPlain(minAmount)} USDC).`
      : undefined)

  return (
    <div className={styles.contentZone}>
      <DepositAmountCard
        chainId={chainId}
        // Match the Send flow's network selector — the shared ChainSelect instead of the card's
        // built-in picker (which the mockup lacks; we keep a picker here but style it consistently).
        chainSlot={<ChainSelect value={chainId} onChange={onChainIdChange} label="Network" />}
        header={
          <SegmentedControl<ShieldTab>
            size="sm"
            aria-label="Shield or unshield"
            value={tab}
            onChange={onTabChange}
            options={SHIELD_TABS}
          />
        }
        title={title}
        amount={amountStr}
        onAmountChange={onAmountChange}
        balance={balance}
        pendingBalance={pendingBalance}
        displayFees={displayFees}
        flowBreakdown={flowBreakdown}
        feeLoading={feeLoading}
        onMax={() => onAmountChange(formatUsdcPlain(maxInput))}
        maxInput={maxInput}
        error={errorMessage}
        amountAriaLabel={amountAriaLabel}
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

interface ShieldAmountStepFooterProps {
  amountStr: string
  maxInput: bigint
  /** Minimum valid amount (shield's relayer-fee floor); 0n for unshield. */
  minAmount: bigint
  onCancel: () => void
  onContinue: () => void
}

export function ShieldAmountStepFooter({
  amountStr,
  maxInput,
  minAmount,
  onCancel,
  onContinue,
}: ShieldAmountStepFooterProps) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const tooSmall = minAmount > 0n && amount > 0n && amount <= minAmount
  const canReview = hasActiveAmount(amountStr) && !tooMuch && !tooSmall && !parseError

  return (
    <div className={depositOverlayShellStyles.buttonRow}>
      <Button variant="secondary" size="lg" label="Cancel" showIcon={false} onClick={onCancel} />
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
