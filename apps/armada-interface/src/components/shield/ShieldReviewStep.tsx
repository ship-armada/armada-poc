// ABOUTME: Shield review step — frost card with left-aligned UI title + big mono amount, shared DepositReviewSummary table, Confirm/Back CTAs.
// ABOUTME: Delegates the summary rows (network, wallet/Armada addresses, fees, total) to DepositReviewSummary; duplicate caution preserved.

import { AlertTriangle } from 'lucide-react'
import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { DepositReviewSummary } from '@/components/deposit/DepositReviewSummary'
import { FeeUpdatedBanner } from '@/components/flow/FeeUpdatedBanner/FeeUpdatedBanner'
import { formatUsdcPlain } from '@/lib/format'
import styles from './ShieldReviewStep.module.css'

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
  /** True when a submit-time fee refetch changed the fee — surfaces the FeeUpdatedBanner. */
  feeUpdated?: boolean
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
  feeUpdated,
  onBack,
  onConfirm,
}: ShieldReviewStepProps) {
  return (
    <div className={styles.root}>
      <div className={`${styles.body} ${modalStepBodyEnter}`}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>Review your USDC deposit</h1>
          <div className={styles.amountRow}>
            <span className={styles.amountValue}>{formatUsdcPlain(amount)}</span>
          </div>
        </div>

        {feeUpdated ? <FeeUpdatedBanner /> : null}

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
              A deposit of this amount may still be processing on chain. Submitting again could
              deposit twice — check Recent Activity first.
            </span>
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
          label="Confirm"
          showIcon={false}
          className={styles.confirmButton}
          onClick={onConfirm}
          disabled={isSubmitting}
        />
      </div>
    </div>
  )
}
