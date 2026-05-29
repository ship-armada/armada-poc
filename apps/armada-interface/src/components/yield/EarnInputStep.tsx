// ABOUTME: Earn input step — tab switcher (Add Funds / Withdraw) + amount + APY hint + fee summary.
// ABOUTME: APY display is honest about its source: shows "—" with disclaimer when useYieldRate is unwired or rateToApy returns 0.

import { AmountInput, FeeSummary, Tabs } from '@/components/ui'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { rateToApy } from '@/lib/yield'
import type { YieldRate } from '@/hooks/useYieldRate'
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
  /**
   * Maximum typeable amount with the fee already reserved. Both yield kinds are fee-on-top, so
   * Add → `shieldedUsdc - fee`, Withdraw → `earningUsdc` (fee paid from shielded USDC, not vault
   * shares). Keeps `totalDeducted ≤ shielded` enforceable here without leaking per-kind math.
   */
  max: bigint
  /** Current yield rate; null while syncing. Drives the APY hint copy. */
  rate: YieldRate | null
  fee: bigint | null
  /**
   * Bottom-line USDC number for the FeeSummary, computed by the modal per tab. For Add this is
   * the literal private-balance debit (`amount + fee`); for Withdraw it's the net private
   * balance gain (`amount - fee`), matching the actual yield-withdraw balance flow.
   */
  netAmount: bigint
  /** Label paired with `netAmount` — also per-tab from the modal. */
  netLabel: string
  /**
   * When set, the Continue button is disabled and an inline message renders. Used by the modal
   * to surface the "private USDC < withdrawal fee" pre-flight on the withdraw tab — see
   * EarnModal for the rationale (fee unshields from existing private USDC, not redeem proceeds).
   */
  continueBlockedReason?: string | null
  isFeeRefreshing?: boolean
  onCancel: () => void
  onContinue: () => void
}

function formatApy(rate: YieldRate | null): string {
  if (!rate) return 'syncing…'
  const apy = rateToApy(rate.apyBps)
  if (apy === 0) return 'unavailable — pool currently pays no yield'
  return `~${apy.toFixed(2)}%`
}

export function EarnInputStep({
  tab,
  onTabChange,
  amountStr,
  onAmountChange,
  max,
  rate,
  fee,
  netAmount,
  netLabel,
  continueBlockedReason,
  isFeeRefreshing,
  onCancel,
  onContinue,
}: EarnInputStepProps) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > max
  // Add tab caps the typeable max at `shieldedUsdc - fee`; an overflow there means amount + fee
  // would exceed the shielded balance. Spell that out so users don't think their balance is wrong.
  const overflowMessage =
    tab === 'add'
      ? 'Amount + relayer fee exceeds your private balance.'
      : 'Amount exceeds your earning balance.'
  const amountError =
    usdcInputErrorMessage(parseError) ?? (tooMuch ? overflowMessage : undefined)

  const isValid = amount > 0n && !tooMuch && !parseError && !continueBlockedReason

  return (
    <div className={styles.root}>
      <Tabs items={TABS} selected={tab} onSelect={onTabChange} ariaLabel="Earn mode" />
      <AmountInput
        variant="display"
        label={tab === 'add' ? 'How much to add?' : 'How much to withdraw?'}
        value={amountStr}
        onValueChange={onAmountChange}
        max={max}
        error={amountError}
      />
      <div className={styles.apyBlock}>
        <div className={styles.apyLabel}>Estimated APY</div>
        <div className={styles.apyValue}>{formatApy(rate)}</div>
        <div className={styles.apyCaveat}>
          Based on the vault's recent rate; the actual yield earned will vary.
        </div>
      </div>
      <FeeSummary
        fee={fee}
        netAmount={netAmount}
        netLabel={netLabel}
        feeLabel="Relayer fee"
        isRefreshing={isFeeRefreshing}
      />
      {continueBlockedReason ? (
        <div className={styles.feeBlockedNotice} role="status" aria-live="polite">
          {continueBlockedReason}
        </div>
      ) : null}
      <FlowFooter
        className={styles.footer}
        primary={{ label: 'Continue', onClick: onContinue, disabled: !isValid }}
        secondary={{ label: 'Cancel', onClick: onCancel }}
      />
    </div>
  )
}
