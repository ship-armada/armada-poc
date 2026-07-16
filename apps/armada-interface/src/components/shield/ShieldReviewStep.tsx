// ABOUTME: Shield review step — read-only echo of the deposit summary with Confirm + Back CTAs.
// ABOUTME: Renders the same big Charis-SIL numeral as the input step so the user sees their amount in the same visual context.

import { AlertTriangle } from 'lucide-react'
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
  /** S-L7: an unresolved same-amount deposit may still be on-chain — surface a non-blocking caution. */
  duplicateWarning?: boolean
  onBack: () => void
  onConfirm: () => void
}

export function ShieldReviewStep({
  fromChainId,
  amount,
  fee,
  netAmount,
  isSubmitting,
  duplicateWarning,
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
      {duplicateWarning ? (
        <div className={styles.caution} role="alert">
          <AlertTriangle size={16} className={styles.cautionIcon} aria-hidden="true" />
          <span>
            A deposit of this amount may still be processing on chain. Submitting again could deposit
            twice — check Recent Activity first.
          </span>
        </div>
      ) : null}
      <FlowFooter
        className={styles.footer}
        primary={{ label: 'Confirm deposit', onClick: onConfirm, disabled: isSubmitting }}
        secondary={{ label: 'Back', onClick: onBack }}
      />
    </div>
  )
}
