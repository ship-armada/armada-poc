// ABOUTME: Warning below the amount card when the EVM wallet lacks native token for gas.

import styles from './GasBalanceNotice.module.css'

export interface GasBalanceNoticeProps {
  nativeSymbol: string
  formattedBalance: string | null
}

export function GasBalanceNotice({ nativeSymbol, formattedBalance }: GasBalanceNoticeProps) {
  const balanceHint =
    formattedBalance != null
      ? ` You have ${formattedBalance} ${nativeSymbol}.`
      : ''
  return (
    <div className={styles.notice} role="status">
      Not enough {nativeSymbol} in your wallet to pay network gas.{balanceHint} Add funds on
      this chain, then try again.
    </div>
  )
}
