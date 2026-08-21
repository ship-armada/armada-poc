// ABOUTME: Earn review step — frost card with left-aligned UI title + big mono amount, shared EarnReviewSummary table, Confirm/Back CTAs.
// ABOUTME: Delegates the summary rows (mode, APY, amount, fees, total) to EarnReviewSummary; keeps the sync-gate + slippage notices.

import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { EarnReviewSummary } from './EarnReviewSummary'
import { FeeUpdatedBanner } from '@/components/flow/FeeUpdatedBanner/FeeUpdatedBanner'
import { formatUsdcPlain } from '@/lib/format'
import type { YieldRate } from '@/hooks/useYieldRate'
import type { EarnTab } from './EarnInputStep'
import styles from './EarnReviewStep.module.css'

export interface EarnReviewStepProps {
  tab: EarnTab
  amount: bigint
  rate: YieldRate | null
  /** Inclusive fee total — broadcaster + protocol. No CCTP on yield kinds. */
  fee: bigint | null
  /**
   * Bottom-line USDC number for the summary total row, computed by the modal per tab. For Add this
   * is the private-balance debit (`amount + fee`); for Withdraw it's the net private-balance gain
   * (`amount`), matching the actual yield-withdraw balance flow.
   */
  netAmount: bigint
  /** Label paired with `netAmount` — also per-tab from the modal. */
  netLabel: string
  submitBlockedReason?: string | null
  /** True while a submit is in flight — disables Confirm so a double-click can't create two txs. */
  isSubmitting?: boolean
  /** True when a submit-time fee refetch changed the fee — surfaces the FeeUpdatedBanner. */
  feeUpdated?: boolean
  onBack: () => void
  onConfirm: () => void
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
  feeUpdated,
  onBack,
  onConfirm,
}: EarnReviewStepProps) {
  const title = tab === 'add' ? 'Review your USDC deposit' : 'Review your USDC withdrawal'
  const confirmLabel = tab === 'add' ? 'Confirm deposit' : 'Confirm withdrawal'

  return (
    <div className={styles.root}>
      <div className={`${styles.body} ${modalStepBodyEnter}`}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{title}</h1>
          <div className={styles.amountRow}>
            <span className={styles.amountValue}>{formatUsdcPlain(amount)}</span>
          </div>
        </div>

        {feeUpdated ? <FeeUpdatedBanner /> : null}

        <EarnReviewSummary
          tab={tab}
          amount={amount}
          rate={rate}
          fee={fee}
          netAmount={netAmount}
          netLabel={netLabel}
        />

        {tab === 'withdraw' ? (
          <p className={styles.slippageNotice}>
            The vault rate moves with each new block. Your final USDC may differ slightly from this
            quote.
          </p>
        ) : null}

        {submitBlockedReason ? (
          <div className={styles.syncNotice} role="status" aria-live="polite">
            {submitBlockedReason}
          </div>
        ) : null}
      </div>

      <div className={`${styles.buttonRow} ${modalActionRowEnter}`}>
        <Button
          variant="secondary"
          size="lg"
          label="Back"
          showIcon={false}
          className={styles.cancelButton}
          onClick={onBack}
        />
        <Button
          variant="primary"
          size="lg"
          label={confirmLabel}
          showIcon={false}
          className={styles.confirmButton}
          onClick={onConfirm}
          disabled={Boolean(submitBlockedReason) || isSubmitting}
        />
      </div>
    </div>
  )
}
