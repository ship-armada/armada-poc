// ABOUTME: Review-step banner shown when the relayer's fee changed between review and submit — the modal re-reviews instead of silently swapping the fee.
// ABOUTME: Presentational; the review step renders it above the summary when its flow reports feeChanged.

import { InformationCircleIcon } from '@heroicons/react/24/outline'
import styles from './FeeUpdatedBanner.module.css'

export interface FeeUpdatedBannerProps {
  /** Optional formatted new fee (e.g. "$0.12") — appended to the copy when provided. */
  feeLabel?: string
}

export function FeeUpdatedBanner({ feeLabel }: FeeUpdatedBannerProps) {
  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <span className={styles.iconTile} aria-hidden>
        <InformationCircleIcon className={styles.icon} strokeWidth={1.75} />
      </span>
      <span className={styles.text}>
        The network fee changed{feeLabel ? ` to ${feeLabel}` : ''}. Review the updated amount, then
        confirm to continue.
      </span>
    </div>
  )
}
