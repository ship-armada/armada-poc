// ABOUTME: List-row item for wallet pickers — icon (img/component/placeholder) + name + optional balance.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; props interface promoted to `export` so consumers can import the type.

import type { ReactNode } from 'react'
import styles from './WalletItem.module.css'

export interface WalletItemProps {
  name: string
  iconSrc?: string
  iconComponent?: ReactNode
  balance?: string
  onClick: () => void
  disabled?: boolean
}

export default function WalletItem({
  name,
  iconSrc,
  iconComponent,
  balance,
  onClick,
  disabled = false,
}: WalletItemProps) {
  return (
    <button type="button" className={styles.item} onClick={onClick} disabled={disabled}>
      {iconComponent ? (
        <span className={styles.iconSlot}>{iconComponent}</span>
      ) : iconSrc ? (
        <img src={iconSrc} className={styles.icon} alt={name} />
      ) : (
        <div className={styles.iconPlaceholder} />
      )}
      <span className={styles.name}>{name}</span>
      {balance != null && balance !== '' && (
        <span className={styles.balance}>{balance}</span>
      )}
    </button>
  )
}
