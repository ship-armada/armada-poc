// ABOUTME: Send review step — surfaces the resolved kind label (Private transfer / External wallet ± cross-chain) so the user understands what they're confirming.
// ABOUTME: Renders the same hero-numeral + facts-grid layout as Shield/Unshield review for consistency across flows.

import { FlowFooter } from '@/components/flow/FlowFooter'
import { FeeSummary } from '@/components/ui'
import { formatUsdcAmount } from '@/lib/format'
import { getChainById } from '@/config/network'
import { truncateAddress } from '@/lib/format'
import type { SendTab } from './SendInputStep'
import styles from './SendReviewStep.module.css'

export interface SendReviewStepProps {
  tab: SendTab
  destChainId: number
  recipient: string
  amount: bigint
  fee: bigint | null
  /** CCTP fast-fee for xchain. Surfaced as the FeeSummary secondary row when applicable. */
  cctpFee: bigint
  /** USDC deducted from the user's shielded balance — `amount + fee` across all three kinds. */
  totalDeducted: bigint
  isXchain: boolean
  submitBlockedReason?: string | null
  onBack: () => void
  onConfirm: () => void
}

function truncateRecipient(recipient: string): string {
  // 0zk shielded addresses are long alphanumeric strings; reuse truncateAddress's 6+4 shape so they
  // visually match EVM addresses in the same UI surface.
  if (recipient.startsWith('0zk') && recipient.length > 14) {
    return `${recipient.slice(0, 7)}…${recipient.slice(-4)}`
  }
  return truncateAddress(recipient)
}

export function SendReviewStep({
  tab,
  destChainId,
  recipient,
  amount,
  fee,
  cctpFee,
  totalDeducted,
  isXchain,
  submitBlockedReason,
  onBack,
  onConfirm,
}: SendReviewStepProps) {
  const destChain = tab === 'external' ? getChainById(destChainId) : null
  const modeLabel = tab === 'private' ? 'Private transfer' : 'External wallet'

  return (
    <div className={styles.root}>
      <div className={styles.headline}>Review send</div>
      <div className={styles.amountBlock}>
        <span className={styles.amount}>{formatUsdcAmount(amount)}</span>
        <span className={styles.unit}>USDC</span>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Mode</dt>
          <dd>
            {modeLabel}
            {isXchain ? <span className={styles.xchainTag}>cross-chain</span> : null}
          </dd>
        </div>
        {destChain ? (
          <div>
            <dt>To chain</dt>
            <dd>{destChain.name}</dd>
          </div>
        ) : null}
        <div>
          <dt>Recipient</dt>
          <dd className={styles.recipient} title={recipient}>
            {truncateRecipient(recipient)}
          </dd>
        </div>
      </dl>
      <FeeSummary
        fee={fee}
        // Mirrors SendInputStep — single "Total deducted from balance" line across all kinds.
        netAmount={totalDeducted}
        netLabel="Total deducted from balance"
        // All three SendModal kinds are relayer-mediated post-A4/A5 — call the fee what it is.
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
          label: 'Confirm send',
          onClick: onConfirm,
          disabled: Boolean(submitBlockedReason),
        }}
        secondary={{ label: 'Back', onClick: onBack }}
      />
    </div>
  )
}
