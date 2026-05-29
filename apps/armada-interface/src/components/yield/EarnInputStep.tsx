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
  /** USDC actually deducted from the user's shielded balance — `amount + fee` for both kinds. */
  totalDeducted: bigint
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
  totalDeducted,
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

  const isValid = amount > 0n && !tooMuch && !parseError

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
        netAmount={totalDeducted}
        netLabel="Total deducted from balance"
        feeLabel="Relayer fee"
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
