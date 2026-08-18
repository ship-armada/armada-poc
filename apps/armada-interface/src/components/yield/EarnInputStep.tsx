// ABOUTME: Earn amount step — Add/Withdraw pill tabs, serif prompt, chain-less DepositAmountCard + percent pills, and an APY hint on the Add tab.
// ABOUTME: The vault has no chain selection; the APY panel is shown only for deposits (matches the mockup).

import { useMemo } from 'react'
import { Button } from '@/design'
import { DepositAmountCard } from '@/components/deposit/DepositAmountCard/DepositAmountCard'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { GasBalanceNotice } from '@/components/ui'
import type { DisplayFees } from '@/lib/fees/displayFees'
import type { FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import { useGasBalanceWarning } from '@/hooks/useGasBalanceWarning'
import { getNetworkConfig } from '@/config/network'
import { formatUsdcPlain, parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { rateToApy } from '@/lib/yield'
import type { YieldRate } from '@/hooks/useYieldRate'
import { hasActiveAmount } from '@/utils/amountInput'
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
  /** Not-yet-spendable ("pending") shielded USDC (raw) on the Add tab. Shown as a "· X pending"
   *  suffix; excluded from `max`/Max. Omitted or 0 (e.g. local Anvil / Withdraw tab) → no suffix. */
  pending?: bigint
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
  pending,
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
  | 'pending'
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
    <div className={styles.root}>
      <div className={styles.tabs} role="tablist" aria-label="Earn mode">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={[styles.tab, tab === item.id && styles.tabActive].filter(Boolean).join(' ')}
            onClick={() => onTabChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <DepositAmountCard
        chains={chains}
        chainId={hub.chainId}
        // Title now lives inside the card; the vault has no chain selection (no chain row here).
        title={question}
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

      {/* APY hint is a deposit concern — shown on the Add tab only (matches the mockup). */}
      {tab === 'add' ? (
        <div className={styles.apyBlock}>
          <span className={styles.apyLabel}>Estimated APY</span>
          <span className={styles.apyValue}>{formatApy(rate)}</span>
          <p className={styles.apyCaveat}>
            Based on the vault&apos;s recent rate; the actual yield earned will vary.
          </p>
        </div>
      ) : null}
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
