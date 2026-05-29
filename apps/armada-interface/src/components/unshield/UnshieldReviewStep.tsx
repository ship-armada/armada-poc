// ABOUTME: Unshield review step — read-only summary of the withdraw + destination + recipient, with Confirm/Back.
// ABOUTME: Adds a "Cross-chain transfer" hint when isXchain so the user knows to expect the longer lifecycle.

import { FlowFooter } from '@/components/flow/FlowFooter'
import { FeeSummary } from '@/components/ui'
import { formatUsdcAmount, truncateAddress } from '@/lib/format'
import { getChainById } from '@/config/network'
import styles from './UnshieldReviewStep.module.css'

export interface UnshieldReviewStepProps {
  destChainId: number
  recipient: string
  amount: bigint
  fee: bigint | null
  /** CCTP fast-fee on xchain. Surfaced as the FeeSummary secondary row when applicable. */
  cctpFee: bigint
  /** USDC the on-chain recipient will receive. Local: `amount`. Xchain: `amount - cctpFee`. */
  recipientReceives: bigint
  /** USDC deducted from the user's shielded balance. Both kinds post-A5: `amount + fee`. */
  totalDeducted: bigint
  isXchain: boolean
  /** When set, Confirm is disabled and the reason is shown inline. Used to gate the submit
   *  while the shielded-balance sync is still in progress. */
  submitBlockedReason?: string | null
  onBack: () => void
  onConfirm: () => void
}

export function UnshieldReviewStep({
  destChainId,
  recipient,
  amount,
  fee,
  cctpFee,
  recipientReceives,
  totalDeducted,
  isXchain,
  submitBlockedReason,
  onBack,
  onConfirm,
}: UnshieldReviewStepProps) {
  const destChain = getChainById(destChainId)
  return (
    <div className={styles.root}>
      <div className={styles.headline}>Review your withdrawal</div>
      <div className={styles.amountBlock}>
        <span className={styles.amount}>{formatUsdcAmount(amount)}</span>
        <span className={styles.unit}>USDC</span>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>To chain</dt>
          <dd>
            {destChain?.name ?? `Chain ${destChainId}`}
            {isXchain ? <span className={styles.xchainTag}>cross-chain</span> : null}
          </dd>
        </div>
        <div>
          <dt>Recipient</dt>
          <dd className={styles.recipient} title={recipient}>
            {truncateAddress(recipient)}
          </dd>
        </div>
      </dl>
      <FeeSummary
        fee={fee}
        // Mirrors UnshieldInputStep — bottom line is "Total deducted" on the local path; on
        // xchain it's "Recipient receives" (the CCTP-net amount) so the user sees what lands
        // on the destination chain. CCTP fee is surfaced as the secondary row.
        netAmount={isXchain ? recipientReceives : totalDeducted}
        netLabel={isXchain ? 'Recipient receives' : 'Total deducted from balance'}
        feeLabel="Relayer fee"
        secondaryFee={isXchain ? cctpFee : undefined}
        secondaryFeeLabel={isXchain ? 'CCTP delivery fee' : undefined}
      />
      {submitBlockedReason ? (
        <div className={styles.syncNotice} role="status" aria-live="polite">
          {submitBlockedReason}
        </div>
      ) : null}
      <FlowFooter
        className={styles.footer}
        primary={{
          label: 'Confirm withdrawal',
          onClick: onConfirm,
          disabled: Boolean(submitBlockedReason),
        }}
        secondary={{ label: 'Back', onClick: onBack }}
      />
    </div>
  )
}
