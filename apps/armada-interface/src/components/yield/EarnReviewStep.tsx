// ABOUTME: Earn review step — serif title, USDC coin + amount block, shared EarnReviewSummary table, Confirm/Back CTAs.
// ABOUTME: Delegates the summary rows (mode, APY, amount, fees, total) to EarnReviewSummary; keeps the sync-gate + slippage notices.

import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { Button } from '@/design'
import { EarnReviewSummary } from './EarnReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import type { YieldRate } from '@/hooks/useYieldRate'
import type { EarnTab } from './EarnInputStep'
import styles from './EarnReviewStep.module.css'

const TOKEN_BADGE_PX = 40
/** @web3icons branded assets use an 18px circle in a 24px viewBox — scale up to fill the badge. */
const TOKEN_ICON_SIZE = Math.round((TOKEN_BADGE_PX * 24) / 18)

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
  onBack,
  onConfirm,
}: EarnReviewStepProps) {
  const title = tab === 'add' ? 'Review your deposit' : 'Review your withdrawal'
  const confirmLabel = tab === 'add' ? 'Confirm deposit' : 'Confirm withdrawal'

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>{title}</h1>

      <div className={styles.amountRow}>
        <div className={styles.amountGroup}>
          <span className={styles.tokenBadge} aria-hidden="true">
            <TokenUSDC size={TOKEN_ICON_SIZE} variant="branded" className={styles.tokenBadgeIcon} />
          </span>
          <span className={[styles.amountValue, usdcAmount.font].join(' ')}>
            {formatUsdcPlain(amount)}
          </span>
        </div>
      </div>

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
          The vault rate moves with each new block. Your final USDC may differ slightly from this quote.
        </p>
      ) : null}

      {submitBlockedReason ? (
        <div className={styles.syncNotice} role="status" aria-live="polite">
          {submitBlockedReason}
        </div>
      ) : null}

      <div className={styles.buttonRow}>
        <Button variant="secondary" size="lg" label="Back" showIcon={false} onClick={onBack} />
        <Button
          variant="primary"
          size="lg"
          label={confirmLabel}
          showIcon={false}
          onClick={onConfirm}
          disabled={Boolean(submitBlockedReason) || isSubmitting}
        />
      </div>
    </div>
  )
}
