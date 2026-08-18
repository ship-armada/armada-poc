// ABOUTME: TransferReviewSummary — send/withdraw summary table (date / private account / recipient / fees) with a fee-on-top "Total" row + a leading privacy notice.
// ABOUTME: Shares DepositReviewSummary's styling so the two flows stay visually in sync; an optional confirmedAt swaps the notice for a "Date and time" row.

import { GlobeAltIcon } from '@heroicons/react/24/outline'
import { ArmadaLogo } from '@/design'
import { WalletProviderIcon } from '@/components/ui/WalletProviderIcon'
import { formatTransactionDateTime, formatUsdcAmount, truncateAddress } from '@/lib/format'
import { isShieldedAddress } from '@/lib/address'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import type { SendFlowVariant } from '../SendRecipientStep'
// Import the deposit summary's styles directly so the send/withdraw table stays in visual sync with it.
import styles from '../../deposit/DepositReviewSummary/DepositReviewSummary.module.css'

const ROW_ICON_PX = 16

export interface TransferReviewSummaryProps {
  /** Destination address (0zk shielded or 0x public) — its format drives the privacy notice + recipient icon. */
  recipient: string
  /** The user's own shielded (Armada) address — rendered (truncated) as the "From your private account" row when present. */
  armadaAddress?: string
  /** Inclusive fee total — broadcaster + protocol + CCTP. Rendered as "—" when null (pre-quote-load). */
  fee: bigint | null
  /** USDC deducted from the user's shielded balance. Fee-on-top, so this is `amount + fee`. */
  totalDeducted: bigint
  variant: SendFlowVariant
  /** Destination chain name — rendered on the "Network" row for public (0x) recipients only. */
  networkName?: string
  /**
   * Wallet provider name (wagmi connector) to brand a public (0x) recipient's row glyph. Passed
   * only when the recipient is the user's own connected wallet (e.g. withdraw-to-self) — for an
   * arbitrary recipient it's omitted and a generic wallet glyph is shown instead. Matches the
   * deposit flow's "From your wallet" treatment. Ignored for private (0zk) recipients.
   */
  recipientWalletProvider?: string
  /** Completion timestamp (ms) — when present, adds a leading "Date and time" row and hides the privacy notice. */
  confirmedAt?: number
}

// `variant` is accepted for API symmetry with the review/complete steps; the summary copy no longer
// branches on it (the amount lives in the big block above), so it isn't destructured here.
export function TransferReviewSummary({
  recipient,
  armadaAddress,
  fee,
  totalDeducted,
  networkName,
  recipientWalletProvider,
  confirmedAt,
}: TransferReviewSummaryProps) {
  // Private (0zk → 0zk) transfers stay inside the shielded pool; anything else exits to a public
  // wallet. Drives the recipient-row icon, whether the network row shows, and the privacy notice.
  const isPrivate = isShieldedAddress(recipient)
  const privacyNotice = isPrivate
    ? { title: 'Private transfer.', body: 'You are sending to an Armada address.' }
    : { title: 'Public transfer.', body: 'You are sending to an external address.' }
  return (
    <div className={styles.summary}>
      <div className={styles.summaryBody}>
        {confirmedAt !== undefined ? (
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Date and time</span>
            <span className={styles.summaryValue}>{formatTransactionDateTime(confirmedAt)}</span>
          </div>
        ) : null}
        {/* Network only applies to a public unshield to a specific chain — a private transfer has
            no destination-chain concept, so the row is omitted. */}
        {!isPrivate && networkName ? (
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Network</span>
            <span className={styles.summaryValue}>{networkName}</span>
          </div>
        ) : null}
        {armadaAddress ? (
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>From your private account</span>
            <span className={styles.summaryValue}>
              <span className={styles.valueWithIcon}>
                <ArmadaLogo variant="mark" markTone="deep" className={styles.armadaIcon} />
                <span>{truncateAddress(armadaAddress)}</span>
              </span>
            </span>
          </div>
        ) : null}
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>To recipient</span>
          <span className={styles.summaryValue}>
            <span className={styles.valueWithIcon}>
              {/* A private (0zk) recipient carries the Armada mark; a public wallet address carries
                  a wallet-provider glyph (brand when it's the user's own wallet, else generic) —
                  mirroring the deposit flow's "From your wallet" row. */}
              {isPrivate ? (
                <ArmadaLogo variant="mark" markTone="deep" className={styles.armadaIcon} />
              ) : (
                <WalletProviderIcon provider={recipientWalletProvider} size={ROW_ICON_PX} />
              )}
              <span>{truncateAddress(recipient)}</span>
            </span>
          </span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Fees</span>
          <span className={[styles.summaryValue, usdcAmount.font].join(' ')}>
            {fee === null ? '—' : `${formatUsdcAmount(fee)} USDC`}
          </span>
        </div>
      </div>
      {/* Send/withdraw fees are fee-on-top: the shielded balance is charged `amount + fee`, so the
          total is the full deduction (not a net "you'll receive" figure like the deposit flow). */}
      <div className={styles.summaryTotalRow}>
        <span className={styles.summaryTotalLabel}>Total</span>
        <span className={[styles.summaryTotalValue, usdcAmount.font].join(' ')}>
          {formatUsdcAmount(totalDeducted)} USDC
        </span>
      </div>
      {/* Privacy notice — shown pre-confirmation only; the confirmation view carries the date row instead. */}
      {confirmedAt === undefined ? (
        <div className={styles.privacyNotice} role="note">
          <span
            className={[
              styles.privacyNoticeIcon,
              isPrivate ? styles.privacyNoticeIconPrivate : styles.privacyNoticeIconPublic,
            ].join(' ')}
            aria-hidden
          >
            {isPrivate ? (
              <ArmadaLogo variant="mark" markTone="deep" className={styles.privacyNoticeMark} />
            ) : (
              <GlobeAltIcon className={styles.privacyNoticeMark} strokeWidth={1.75} />
            )}
          </span>
          <div className={styles.privacyNoticeCopy}>
            <p className={styles.privacyNoticeTitle}>{privacyNotice.title}</p>
            <p className={styles.privacyNoticeBody}>{privacyNotice.body}</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
