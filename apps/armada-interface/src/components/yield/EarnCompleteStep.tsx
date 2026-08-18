// ABOUTME: Earn complete step — serif "Deposit to vault complete"/"Withdrawal from vault complete" title, coin + amount, EarnReviewSummary (with date/time), explorer/dashboard CTAs.
// ABOUTME: Mirrors SendCompleteStep — no divider between the summary card and the button row.

import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { Button } from '@/design'
import { EarnReviewSummary } from './EarnReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import type { YieldRate } from '@/hooks/useYieldRate'
import type { EarnTab } from './EarnInputStep'
import styles from './EarnCompleteStep.module.css'

const TOKEN_BADGE_PX = 40
/** @web3icons branded assets use an 18px circle in a 24px viewBox — scale up to fill the badge. */
const TOKEN_ICON_SIZE = Math.round((TOKEN_BADGE_PX * 24) / 18)

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
  const title = tab === 'add' ? 'Deposit to vault complete' : 'Withdrawal from vault complete'

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
        confirmedAt={confirmedAt}
      />

      <div className={styles.buttonRow}>
        <Button
          variant="secondary"
          size="lg"
          label="View on explorer"
          showIcon={false}
          onClick={onViewExplorer}
          disabled={!explorerUrl}
        />
        <Button
          variant="primary"
          size="lg"
          label="Go to dashboard"
          showIcon={false}
          onClick={onGoToDashboard}
        />
      </div>
    </div>
  )
}
