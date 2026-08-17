// ABOUTME: Shield review step — serif title, USDC coin + full-precision amount block, shared DepositReviewSummary table, Confirm/Back CTAs.
// ABOUTME: Delegates the summary rows (network, wallet/shielded addresses, deposit amount, fees, total) to DepositReviewSummary; duplicate caution preserved.

import { AlertTriangle } from 'lucide-react'
import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { Button } from '@/design'
import { DepositReviewSummary } from '@/components/deposit/DepositReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import styles from './ShieldReviewStep.module.css'

const TOKEN_BADGE_PX = 40
/** @web3icons branded assets use an 18px circle in a 24px viewBox — scale up to fill the badge. */
const TOKEN_ICON_SIZE = Math.round((TOKEN_BADGE_PX * 24) / 18)

export interface ShieldReviewStepProps {
  fromChainId: number
  amount: bigint
  fee: bigint | null
  netAmount: bigint
  /** Connected EVM wallet address — rendered (truncated) as the "From your wallet" row when present. */
  walletAddress?: string
  /** Connected wallet provider name (wagmi connector) — drives the "From your wallet" brand glyph. */
  walletProvider?: string
  /** Shielded (Armada) destination address — rendered (truncated) as the "To your private account" row when present. */
  shieldedAddress?: string
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
  walletAddress,
  walletProvider,
  shieldedAddress,
  isSubmitting,
  duplicateWarning,
  onBack,
  onConfirm,
}: ShieldReviewStepProps) {
  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Review your deposit</h1>

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
      />

      {duplicateWarning ? (
        <div className={styles.caution} role="alert">
          <AlertTriangle size={16} className={styles.cautionIcon} aria-hidden="true" />
          <span>
            A deposit of this amount may still be processing on chain. Submitting again could deposit
            twice — check Recent Activity first.
          </span>
        </div>
      ) : null}

      <div className={styles.buttonRow}>
        <Button variant="secondary" size="lg" label="Back" showIcon={false} onClick={onBack} />
        <Button
          variant="primary"
          size="lg"
          label="Confirm deposit"
          showIcon={false}
          onClick={onConfirm}
          disabled={isSubmitting}
        />
      </div>
    </div>
  )
}
