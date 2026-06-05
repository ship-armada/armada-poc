// ABOUTME: Dashboard hero card — total private USDC, with "Available privately" + "Earning in vault" sub-balances.
// ABOUTME: Renders a syncing placeholder when shielded balance or yield shares are null (sync not finished); never shows $0 in that state.

import { useAtomValue } from 'jotai'
import { Card } from '@/components/ui'
import { formatUsdcAmount } from '@/lib/format'
import { sharesToUsdc } from '@/lib/yield'
import { yieldSharesAtom } from '@/state/wallet'
import { usePrivateUsdcDisplay } from '@/hooks/usePrivateUsdcDisplay'
import { useYieldRate } from '@/hooks/useYieldRate'
import styles from './BalanceHero.module.css'

export function BalanceHero() {
  const { displayBalance, isSyncing } = usePrivateUsdcDisplay()
  const yieldShares = useAtomValue(yieldSharesAtom)
  const { rate: yieldRate } = useYieldRate()

  const earningUsdc =
    yieldShares !== null && yieldRate !== null
      ? sharesToUsdc(yieldShares, yieldRate.rate)
      : null

  const total = displayBalance + (earningUsdc ?? 0n)

  return (
    <Card variant="raised" className={styles.card}>
      <div className={styles.label}>Total private USDC</div>
      {isSyncing ? (
        <div className={styles.syncing}>Syncing private balance…</div>
      ) : (
        <div className={styles.totalRow}>
          <span className={styles.totalAmount}>
            {formatUsdcAmount(total)}
          </span>
          <span className={styles.totalUnit}>USDC</span>
        </div>
      )}

      <div className={styles.breakdown}>
        <div className={styles.breakdownItem}>
          <div className={styles.breakdownLabel}>Available privately</div>
          <div className={styles.breakdownValue}>
            {isSyncing ? '—' : formatUsdcAmount(displayBalance)}
          </div>
        </div>
        <div className={styles.breakdownDivider} aria-hidden="true" />
        <div className={styles.breakdownItem}>
          <div className={styles.breakdownLabel}>Earning in vault</div>
          <div className={styles.breakdownValue}>
            {earningUsdc === null ? '—' : formatUsdcAmount(earningUsdc)}
          </div>
        </div>
      </div>
    </Card>
  )
}
