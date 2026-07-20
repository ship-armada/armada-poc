// ABOUTME: Earn review step — echoes the requested amount, the resolved mode (Add Funds / Withdraw), the APY used for the quote, and the fee summary.
// ABOUTME: Same hero-numeral + facts layout as the other review steps for visual consistency.

import { FlowFooter } from '@/components/flow/FlowFooter'
import { FeeSummary } from '@/components/ui'
import { formatUsdcAmount } from '@/lib/format'
import { rateToApy } from '@/lib/yield'
import type { YieldRate } from '@/hooks/useYieldRate'
import type { EarnTab } from './EarnInputStep'
import styles from './EarnReviewStep.module.css'

export interface EarnReviewStepProps {
  tab: EarnTab
  amount: bigint
  rate: YieldRate | null
  fee: bigint | null
  /**
   * Bottom-line USDC number for the FeeSummary, computed by the modal per tab. For Add this is
   * the private-balance debit (`amount + fee`); for Withdraw it's the net private-balance gain
   * (`amount - fee`), matching the actual yield-withdraw balance flow.
   */
  netAmount: bigint
  /** Label paired with `netAmount` — also per-tab from the modal. */
  netLabel: string
  submitBlockedReason?: string | null
  /** True while a submit is in flight — disables Confirm so a double-click can't create two txs. */
  isSubmitting?: boolean
  onBack: () => void
  onConfirm: () => void
}

function formatApy(rate: YieldRate | null): string {
  if (!rate) return 'syncing…'
  const apy = rateToApy(rate.apyBps)
  if (apy === 0) return 'unavailable'
  return `~${apy.toFixed(2)}%`
}

export function EarnReviewStep({
  tab,
  amount,
  rate,
  fee,
  netAmount,
  netLabel,
  submitBlockedReason,
  isSubmitting,
  onBack,
  onConfirm,
}: EarnReviewStepProps) {
  const modeLabel = tab === 'add' ? 'Add to vault' : 'Withdraw from vault'

  return (
    <div className={styles.root}>
      <div className={styles.headline}>Review {tab === 'add' ? 'deposit' : 'withdrawal'}</div>
      <div className={styles.amountBlock}>
        <span className={styles.amount}>{formatUsdcAmount(amount)}</span>
        <span className={styles.unit}>USDC</span>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Mode</dt>
          <dd>{modeLabel}</dd>
        </div>
        <div>
          <dt>Estimated APY</dt>
          <dd>{formatApy(rate)}</dd>
        </div>
      </dl>
      <FeeSummary
        fee={fee}
        netAmount={netAmount}
        netLabel={netLabel}
        feeLabel="Relayer fee"
      />
      {tab === 'withdraw' ? (
        <div className={styles.slippageNotice}>
          The vault rate moves with each new block. Your final USDC may differ slightly from
          this quote.
        </div>
      ) : null}
      {submitBlockedReason ? (
        <div className={styles.syncNotice} role="status" aria-live="polite">
          {submitBlockedReason}
        </div>
      ) : null}
      <FlowFooter
        className={styles.footer}
        primary={{
          label: tab === 'add' ? 'Confirm deposit' : 'Confirm withdrawal',
          onClick: onConfirm,
          disabled: Boolean(submitBlockedReason) || isSubmitting,
        }}
        secondary={{ label: 'Back', onClick: onBack }}
      />
    </div>
  )
}
