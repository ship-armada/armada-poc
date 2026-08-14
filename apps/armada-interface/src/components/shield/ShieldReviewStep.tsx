// ABOUTME: Shield review step — serif title, USDC coin + amount block, borderless deposit summary table, Confirm/Back CTAs.
// ABOUTME: Summary rows (network, wallet/shielded addresses, fees, total) replace the prior FeeSummary; duplicate caution + FlowFooter behavior preserved.

import { AlertTriangle } from 'lucide-react'
import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { formatUsdcAmount, truncateAddress } from '@/lib/format'
import { getChainById } from '@/config/network'
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
  /** Shielded (Armada) destination address — rendered (truncated) as the "To Armada" row when present. */
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
  shieldedAddress,
  isSubmitting,
  duplicateWarning,
  onBack,
  onConfirm,
}: ShieldReviewStepProps) {
  const fromChain = getChainById(fromChainId)
  const feeValue = fee ?? 0n
  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Review</h1>

      <div className={styles.amountRow}>
        <div className={styles.amountGroup}>
          <span className={styles.tokenBadge} aria-hidden="true">
            <TokenUSDC size={TOKEN_ICON_SIZE} variant="branded" className={styles.tokenBadgeIcon} />
          </span>
          <span className={[styles.amountValue, usdcAmount.font].join(' ')}>
            {formatUsdcAmount(amount)}
          </span>
        </div>
      </div>

      <div className={styles.summary}>
        <div className={styles.summaryBody}>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Network</span>
            <span className={styles.summaryValue}>
              {fromChain?.name ?? `Chain ${fromChainId}`}
            </span>
          </div>
          {walletAddress ? (
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>From your wallet</span>
              <span className={styles.summaryValue}>{truncateAddress(walletAddress)}</span>
            </div>
          ) : null}
          {shieldedAddress ? (
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>To Armada</span>
              <span className={styles.summaryValue}>{truncateAddress(shieldedAddress)}</span>
            </div>
          ) : null}
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Fees</span>
            <span className={[styles.summaryValue, usdcAmount.font].join(' ')}>
              {fee === null ? '—' : `${formatUsdcAmount(feeValue)} USDC`}
            </span>
          </div>
        </div>
        {/* Fees are inclusive (fee-from-recipient): the wallet is debited `amount` and the shielded
            pool receives `amount - fees`. Show that net figure — the honest "what lands in your
            account" — as the emphasized row, not a misleading amount+fee total. */}
        <div className={styles.summaryTotalRow}>
          <span className={styles.summaryTotalLabel}>You'll deposit</span>
          <span className={[styles.summaryTotalValue, usdcAmount.font].join(' ')}>
            {formatUsdcAmount(netAmount)} USDC
          </span>
        </div>
      </div>

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
