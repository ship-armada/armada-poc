// ABOUTME: Shield review step — read-only echo of the deposit summary with Confirm + Back CTAs.
// ABOUTME: Renders the same big Charis-SIL numeral as the input step so the user sees their amount in the same visual context.

import { FlowFooter } from '@/components/flow/FlowFooter'
import { FeeSummary } from '@/components/ui'
import { formatUsdcAmount } from '@/lib/format'
import { getChainById } from '@/config/network'
import styles from './ShieldReviewStep.module.css'

export interface ShieldReviewStepProps {
  fromChainId: number
  amount: bigint
  fee: bigint | null
  netAmount: bigint
  /** True while a submit is in flight — disables Confirm so a double-click can't create two txs. */
  isSubmitting?: boolean
  onBack: () => void
  onConfirm: () => void
}

export function ShieldReviewStep({
  fromChainId,
  amount,
  fee,
  netAmount,
  isSubmitting,
  onBack,
  onConfirm,
}: ShieldReviewStepProps) {
  const fromChain = getChainById(fromChainId)
  return (
    <div className={styles.root}>
      <div className={styles.headline}>Review your deposit</div>
      <div className={styles.amountBlock}>
        <span className={styles.amount}>{formatUsdcAmount(amount)}</span>
        <span className={styles.unit}>USDC</span>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>From</dt>
          <dd>{fromChain?.name ?? `Chain ${fromChainId}`}</dd>
        </div>
      </dl>
      <FeeSummary fee={fee} netAmount={netAmount} netLabel="You'll deposit" />
      <FlowFooter
        className={styles.footer}
        primary={{ label: 'Confirm deposit', onClick: onConfirm, disabled: isSubmitting }}
        secondary={{ label: 'Back', onClick: onBack }}
      />
    </div>
  )
}
