// ABOUTME: Shield complete step — serif "Deposit confirmed" title, USDC coin + deposited-amount block, shared DepositReviewSummary (with date/time), and explorer/dashboard CTAs.
// ABOUTME: Mirrors the deposit-confirmed reference — no divider between the summary card and the button row.

import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { Button } from '@/design'
import { DepositReviewSummary } from '@/components/deposit/DepositReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import styles from './ShieldCompleteStep.module.css'

const TOKEN_BADGE_PX = 40
/** @web3icons branded assets use an 18px circle in a 24px viewBox — scale up to fill the badge. */
const TOKEN_ICON_SIZE = Math.round((TOKEN_BADGE_PX * 24) / 18)

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
      <h1 className={styles.title}>Deposit confirmed</h1>

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
