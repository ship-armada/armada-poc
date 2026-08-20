// ABOUTME: Send flow's "Recent address" list — previously-used recipients as tappable rows (arrow badge + truncated address + relative time).
// ABOUTME: Presentational; data is derived by useRecentRecipients and a row click fills the recipient (+ restores its chain) in SendModal.

import { ArrowRightIcon } from '@heroicons/react/24/outline'
import { truncateAddress, formatRelativeTime } from '@/lib/format'
import type { RecentRecipient } from '@/lib/tx/recentRecipients'
import styles from './RecentAddressList.module.css'

export interface RecentAddressListProps {
  items: RecentRecipient[]
  onSelect: (item: RecentRecipient) => void
  /** Wall-clock now (ms) for the relative-time labels; injectable so tests are deterministic. */
  now?: number
}

export function RecentAddressList({ items, onSelect, now = Date.now() }: RecentAddressListProps) {
  if (items.length === 0) return null

  return (
    <div className={styles.recentSection}>
      <span className={styles.recentLabel}>Recent address</span>
      <ul className={styles.recentList}>
        {items.map((item) => (
          <li key={item.address}>
            <button type="button" className={styles.recentItem} onClick={() => onSelect(item)}>
              <span className={styles.recentIconBadge} aria-hidden>
                <ArrowRightIcon className={styles.recentIcon} strokeWidth={1.5} />
              </span>
              <span className={styles.recentAddress}>{truncateAddress(item.address)}</span>
              <span className={styles.recentTime}>{formatRelativeTime(item.lastAt, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
