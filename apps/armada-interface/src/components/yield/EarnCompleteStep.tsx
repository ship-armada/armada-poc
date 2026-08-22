// ABOUTME: Earn complete step — frost card with left-aligned UI title + big mono amount, shared EarnReviewSummary (with date/time), explorer/dashboard CTAs.
// ABOUTME: Mirrors SendCompleteStep — no divider between the summary and the button row.

import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { EarnReviewSummary } from './EarnReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import type { YieldRate } from '@/hooks/useYieldRate'
import type { EarnTab } from './EarnInputStep'
import styles from './EarnCompleteStep.module.css'

export interface EarnCompleteStepProps {
  tab: EarnTab
  /** Requested USDC (raw 6-decimal) — shown full-precision in the coin block. */
  amount: bigint
  rate: YieldRate | null
  /** Inclusive fee total — broadcaster + protocol. Rendered as "—" when null. */
  fee: bigint | null
  /** Per-tab summary total: Add → private-balance debit (`amount + fee`); Withdraw → net gain (`amount`). */
  netAmount: bigint
  netLabel: string
  /** Completion timestamp (ms) — drives the summary's "Date and time" row. */
  confirmedAt: number
  /** Hub-chain explorer URL for the tx; absent disables the "View on explorer" button. */
  explorerUrl?: string
  onViewExplorer: () => void
  onGoToDashboard: () => void
}

export function EarnCompleteStep({
  tab,
  amount,
  rate,
  fee,
  netAmount,
  netLabel,
  confirmedAt,
  explorerUrl,
  onViewExplorer,
  onGoToDashboard,
}: EarnCompleteStepProps) {
  const title = tab === 'add' ? 'USDC shielded transfer to vault complete' : 'USDC withdrawal complete'

  return (
    <div className={styles.root}>
      <div className={`${styles.body} ${modalStepBodyEnter}`}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{title}</h1>
          <div className={styles.amountRow}>
            <span className={styles.amountValue}>{formatUsdcPlain(amount)}</span>
          </div>
        </div>

        <EarnReviewSummary
          tab={tab}
          amount={amount}
          rate={rate}
          fee={fee}
          netAmount={netAmount}
          netLabel={netLabel}
          confirmedAt={confirmedAt}
        />
      </div>

      <div className={`${styles.buttonRow} ${modalActionRowEnter}`}>
        <Button
          variant="secondary"
          size="lg"
          label="View on explorer"
          showIcon={false}
          className={styles.cancelButton}
          onClick={onViewExplorer}
          disabled={!explorerUrl}
        />
        <Button
          variant="primary"
          size="lg"
          label="Go to dashboard"
          showIcon={false}
          className={styles.confirmButton}
          onClick={onGoToDashboard}
        />
      </div>
    </div>
  )
}
