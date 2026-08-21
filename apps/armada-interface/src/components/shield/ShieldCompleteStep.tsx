// ABOUTME: Shield complete step — frost card with left-aligned "USDC shield confirmed" title + big mono shielded-amount, shared DepositReviewSummary (with date/time), and explorer/dashboard CTAs.
// ABOUTME: Mirrors the deposit-confirmed reference — no divider between the summary card and the button row.

import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { DepositReviewSummary } from '@/components/deposit/DepositReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import styles from './ShieldCompleteStep.module.css'

export interface ShieldCompleteStepProps {
  fromChainId: number
  /** Gross amount deposited (pre-fee), raw 6-decimal USDC — shown full-precision in the coin block. */
  amount: bigint
  fee: bigint | null
  /** Net amount deposited (post-fee), raw 6-decimal USDC — the summary's "You'll receive". */
  netAmount: bigint
  walletAddress?: string
  walletProvider?: string
  shieldedAddress?: string
  /** Completion timestamp (ms) — drives the summary's "Date and time" row. */
  confirmedAt: number
  /** Source-chain explorer URL for the deposit tx; absent disables the "View on explorer" button. */
  explorerUrl?: string
  onViewExplorer: () => void
  onGoToDashboard: () => void
}

export function ShieldCompleteStep({
  fromChainId,
  amount,
  fee,
  netAmount,
  walletAddress,
  walletProvider,
  shieldedAddress,
  confirmedAt,
  explorerUrl,
  onViewExplorer,
  onGoToDashboard,
}: ShieldCompleteStepProps) {
  return (
    <div className={styles.root}>
      <div className={`${styles.body} ${modalStepBodyEnter}`}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>USDC shield confirmed</h1>
          <div className={styles.amountRow}>
            <span className={styles.amountValue}>{formatUsdcPlain(amount)}</span>
          </div>
        </div>

        <DepositReviewSummary
          fromChainId={fromChainId}
          amount={amount}
          fee={fee}
          netAmount={netAmount}
          walletAddress={walletAddress}
          walletProvider={walletProvider}
          shieldedAddress={shieldedAddress}
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
