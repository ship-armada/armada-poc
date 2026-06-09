// ABOUTME: Earn amount step — tab switcher, DepositAmountCard, APY hint (full-viewport earn flow).

import { useMemo } from 'react'
import { Button } from '@armada/ui'
import { DepositAmountCard } from '@/components/deposit/DepositAmountCard/DepositAmountCard'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { GasBalanceNotice, Tabs } from '@/components/ui'
import type { DisplayFees } from '@/lib/fees/displayFees'
import type { FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import { useGasBalanceWarning } from '@/hooks/useGasBalanceWarning'
import { getNetworkConfig } from '@/config/network'
import { formatUsdcPlain, parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { rateToApy } from '@/lib/yield'
import type { YieldRate } from '@/hooks/useYieldRate'
import { hasActiveAmount } from '@/utils/amountInput'
import shieldStyles from '@/components/shield/ShieldInputStep.module.css'
import styles from './EarnInputStep.module.css'

export type EarnTab = 'add' | 'withdraw'

const TABS = [
  { id: 'add' as const, label: 'Add funds' },
  { id: 'withdraw' as const, label: 'Withdraw' },
] as const

export interface EarnInputStepProps {
  tab: EarnTab
  onTabChange: (next: EarnTab) => void
  amountStr: string
  onAmountChange: (next: string) => void
  max: bigint
  maxInput: bigint
  displayFees: DisplayFees
  flowBreakdown?: FlowFeeBreakdown
  feeLoading?: boolean
  gasChainId: number
  /**
   * When true, the relayer pays gas — suppresses the GasBalanceNotice. `yield-deposit` defaults
   * to the relayer path; `yield-withdraw` force-routes through the user's wallet (the
   * multi-Transaction shape of `redeemAndShield` doesn't fit the broadcaster path today — see
   * EarnModal). Modal passes the inverse of `effectiveUseWalletOverride`.
   */
  gaslessMode?: boolean
  rate: YieldRate | null
  /**
   * Optional pre-flight gate reason — set on the Withdraw tab when the user's private USDC
   * doesn't cover the broadcaster fee. Surfaced inline + disables Review so the user sees the
   * problem before paying for a 20–30s proof that would inevitably revert.
   */
  continueBlockedReason?: string | null
  onCancel: () => void
  onContinue: () => void
}

function formatApy(rate: YieldRate | null): string {
  if (!rate) return 'syncing…'
  const apy = rateToApy(rate.apyBps)
  if (apy === 0) return 'unavailable — pool currently pays no yield'
  return `~${apy.toFixed(2)}%`
}

export function EarnInputStepContent({
  tab,
  onTabChange,
  amountStr,
  onAmountChange,
  max,
  maxInput,
  displayFees,
  flowBreakdown,
  feeLoading = false,
  gasChainId,
  gaslessMode = true,
  rate,
  continueBlockedReason,
}: Pick<
  EarnInputStepProps,
  | 'tab'
  | 'onTabChange'
  | 'amountStr'
  | 'onAmountChange'
  | 'max'
  | 'maxInput'
  | 'displayFees'
  | 'flowBreakdown'
  | 'feeLoading'
  | 'gasChainId'
  | 'gaslessMode'
  | 'rate'
  | 'continueBlockedReason'
>) {
  const hub = getNetworkConfig().hub
  const chains = useMemo(
    () => [{ chainId: hub.chainId, label: hub.name }],
    [hub.chainId, hub.name],
  )

  const gasWarning = useGasBalanceWarning(gasChainId)
  // Only surface the gas notice when the user actually pays gas themselves. `yield-deposit`
  // defaults to relayer-mediated; `yield-withdraw` is force-routed through the wallet today,
  // so the parent passes `gaslessMode={false}` on that tab and the notice DOES show.
  const showGasNotice = !gaslessMode && gasWarning.show
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const amountError =
    usdcInputErrorMessage(parseError)
    ?? (tooMuch
      ? tab === 'add'
        ? 'Amount exceeds your private balance after fees.'
        : 'Amount exceeds your earning balance after fees.'
      : undefined)

  const question =
    tab === 'add'
      ? 'How much USDC do you want to add to the vault?'
      : 'How much USDC do you want to withdraw from the vault?'

  return (
    <div className={shieldStyles.contentZone}>
      <Tabs items={TABS} selected={tab} onSelect={onTabChange} ariaLabel="Earn mode" />
      <p className={shieldStyles.question}>{question}</p>
      <DepositAmountCard
        chains={chains}
        chainId={hub.chainId}
        amount={amountStr}
        onAmountChange={onAmountChange}
        balance={formatUsdcPlain(max)}
        displayFees={displayFees}
        flowBreakdown={flowBreakdown}
        feeLoading={feeLoading}
        onMax={() => onAmountChange(formatUsdcPlain(maxInput))}
        error={amountError}
        amountAriaLabel={tab === 'add' ? 'Vault deposit amount' : 'Vault withdrawal amount'}
      />
      {showGasNotice ? (
        <GasBalanceNotice
          nativeSymbol={gasWarning.nativeSymbol}
          formattedBalance={gasWarning.formattedBalance}
        />
      ) : null}
      {continueBlockedReason ? (
        <div className={styles.blockedReason} role="alert">
          {continueBlockedReason}
        </div>
      ) : null}
      <div className={styles.apyBlock}>
        <div className={styles.apyLabel}>Estimated APY</div>
        <div className={styles.apyValue}>{formatApy(rate)}</div>
        <div className={styles.apyCaveat}>
          Based on the vault's recent rate; the actual yield earned will vary.
        </div>
      </div>
    </div>
  )
}

export function EarnInputStepFooter({
  amountStr,
  maxInput,
  continueBlockedReason,
  onCancel,
  onContinue,
}: Pick<
  EarnInputStepProps,
  'amountStr' | 'maxInput' | 'continueBlockedReason' | 'onCancel' | 'onContinue'
>) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const canReview =
    hasActiveAmount(amountStr) && !tooMuch && !parseError && !continueBlockedReason

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

export function EarnInputStep(props: EarnInputStepProps) {
  return (
    <>
      <EarnInputStepContent {...props} />
      <EarnInputStepFooter {...props} />
    </>
  )
}
