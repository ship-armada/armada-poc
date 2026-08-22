// ABOUTME: Earn amount step — APY intro banner (DepositTooltip) above a chain-less DepositAmountCard whose in-card header holds the Add/Withdraw SegmentedControl.
// ABOUTME: The vault has no chain selection; the banner headline is driven by the live vault rate and shows on both tabs (matches the mockup).

import { useMemo, useRef, type Ref } from 'react'
import { ChartBarIcon } from '@heroicons/react/24/solid'
import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { DepositAmountCard } from '@/components/deposit/DepositAmountCard/DepositAmountCard'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { DepositTooltip } from '@/components/dashboard/DepositTooltip'
import { GasBalanceNotice, SegmentedControl } from '@/components/ui'
import { useNudgeShake } from '@/hooks/useNudgeShake'
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
  { id: 'add' as const, label: 'Add to vault' },
  { id: 'withdraw' as const, label: 'Withdraw' },
] as const

/** Static copy for the APY intro banner (the live rate fills the headline). */
const EARN_APY_BANNER_BODY = "Add USDC to Armada's shielded vault and start earning now."
const EARN_APY_BANNER_TOOLTIP = 'The APY is an estimate from recent shielded vault performance.'

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
  /** Ref onto the amount input so the footer's incomplete-CTA nudge can focus the field. */
  inputRef?: Ref<HTMLInputElement>
  /** Called when the disabled "Input amount" CTA is tapped — focuses the amount field alongside the shake. */
  onIncompleteContinue?: () => void
}

function formatApy(rate: YieldRate | null): string {
  if (!rate) return 'syncing…'
  const apy = rateToApy(rate.apyBps)
  if (apy === 0) return 'unavailable — pool currently pays no yield'
  return `~${apy.toFixed(2)}%`
}

/** Headline for the APY intro banner — driven by the live vault rate, with sync/zero states. */
function apyBannerHeadline(rate: YieldRate | null): string {
  if (!rate) return 'Estimating vault APY…'
  const apy = rateToApy(rate.apyBps)
  if (apy === 0) return 'Vault currently pays no yield'
  return `Earn ~${apy.toFixed(2)}% APY`
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
  inputRef,
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
  | 'inputRef'
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
        ? "That's more than you can add"
        : "That's more than you can withdraw"
      : undefined)
  // Surface the withdraw fee-shortfall pre-flight block through the same amount-field tooltip as the
  // amount errors. An active amount error takes precedence (immediate feedback on what's being typed);
  // once the amount is otherwise valid the standing shortfall shows.
  const fieldError = amountError ?? continueBlockedReason ?? undefined

  const question =
    tab === 'add' ? 'Deposit USDC to the vault' : 'Withdraw USDC from the vault'

  return (
    <div className={`${styles.root} ${modalStepBodyEnter}`}>
      {/* APY intro banner — shown on both tabs (mockup). The live vault rate fills the headline. */}
      <DepositTooltip
        stretch
        BadgeIcon={ChartBarIcon}
        badgeBackground="white"
        iconTileTone="purple"
        headline={apyBannerHeadline(rate)}
        ariaLabel={`Estimated yearly yield ${formatApy(rate)}`}
        body={EARN_APY_BANNER_BODY}
        infoTooltip={EARN_APY_BANNER_TOOLTIP}
      />

      <DepositAmountCard
        chains={chains}
        chainId={hub.chainId}
        // Add/Withdraw mode tabs live inside the card, above the title (mockup headerSlot).
        header={
          <SegmentedControl<EarnTab>
            size="sm"
            aria-label="Earn mode"
            value={tab}
            onChange={onTabChange}
            options={TABS}
          />
        }
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
        error={fieldError}
        amountAriaLabel={tab === 'add' ? 'Vault deposit amount' : 'Vault withdrawal amount'}
        inputRef={inputRef}
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

export function EarnInputStepFooter({
  amountStr,
  maxInput,
  continueBlockedReason,
  onCancel,
  onContinue,
  onIncompleteContinue,
}: Pick<
  EarnInputStepProps,
  | 'amountStr'
  | 'maxInput'
  | 'continueBlockedReason'
  | 'onCancel'
  | 'onContinue'
  | 'onIncompleteContinue'
>) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const canReview =
    hasActiveAmount(amountStr) && !tooMuch && !parseError && !continueBlockedReason
  const { shaking, nudge, onShakeAnimationEnd } = useNudgeShake()

  return (
    <div className={`${depositOverlayShellStyles.buttonRow} ${modalActionRowEnter}`}>
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
        label={canReview ? 'Review' : 'Input amount'}
        showIcon={false}
        disabled={!canReview}
        onClick={onContinue}
        onDisabledClick={() => {
          nudge()
          onIncompleteContinue?.()
        }}
        shaking={shaking}
        onShakeAnimationEnd={onShakeAnimationEnd}
      />
    </div>
  )
}

export function EarnInputStep(props: EarnInputStepProps) {
  // The step is the common parent of the amount card + footer, so it owns the ref shared between them.
  const amountInputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <EarnInputStepContent {...props} inputRef={amountInputRef} />
      <EarnInputStepFooter
        {...props}
        onIncompleteContinue={() => amountInputRef.current?.focus()}
      />
    </>
  )
}
