// ABOUTME: Withdraw step recipient row — inline label + truncated address (locked connected wallet).

import { truncateAddressEnds } from '@/lib/format'
import styles from './WithdrawRecipientField.module.css'

export interface WithdrawRecipientFieldProps {
  address: string | null
}

export function WithdrawRecipientField({ address }: WithdrawRecipientFieldProps) {
  const display = address ? truncateAddressEnds(address) : '—'

  return (
    <div className={styles.root} aria-label="Recipient address">
      <span className={styles.label}>Recipient address</span>
      <span className={styles.address} title={address ?? undefined}>
        {display}
      </span>
    </div>
  )
}
