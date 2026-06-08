// ABOUTME: Dashboard hero — tall vertical card showing total private USDC, available sub-caption, and a gradient Deposit CTA.
// ABOUTME: "Total" = shielded + sharesToUsdc(yieldShares, rate). "Available" = shielded only (excludes vault). Deposit click opens the shield modal via useOpenActionModal.

import { useAtomValue } from 'jotai'
import { Button } from '@armada/ui'
import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { Card } from '@/components/ui'
import { formatUsdcAmount } from '@/lib/format'
import { sharesToUsdc } from '@/lib/yield'
import { syncStateAtom, yieldSharesAtom } from '@/state/wallet'
import { usePrivateUsdcDisplay } from '@/hooks/usePrivateUsdcDisplay'
import { useYieldRate } from '@/hooks/useYieldRate'
import { useOpenActionModal } from '@/hooks/useOpenActionModal'
import styles from './BalanceHero.module.css'

const USDC_ICON_SIZE = 60

export function BalanceHero() {
  const { displayBalance, isSyncing } = usePrivateUsdcDisplay()
  const yieldShares = useAtomValue(yieldSharesAtom)
  const { rate: yieldRate } = useYieldRate()
  const openActionModal = useOpenActionModal()
  const sync = useAtomValue(syncStateAtom)

  const earningUsdc =
    yieldShares !== null && yieldRate !== null
      ? sharesToUsdc(yieldShares, yieldRate.rate)
      : null

  const total = displayBalance + (earningUsdc ?? 0n)
  // Show the in-card sync UI while the Railgun engine is mid-scan or has failed. Replaces the
  // total + available + Deposit block — the balance isn't trustworthy until sync completes.
  const showSyncBlock = sync.status === 'syncing' || sync.status === 'failed'
  const syncPct = Math.round(Math.max(0, Math.min(1, sync.progress)) * 100)

  return (
    <Card variant="raised" className={styles.card}>
      <div className={styles.label}>Total USDC Private Balance</div>
      <span className={styles.icon} aria-hidden="true">
        <TokenUSDC size={USDC_ICON_SIZE} variant="branded" />
      </span>
      {showSyncBlock ? (
        sync.status === 'failed' ? (
          <div className={styles.syncBlock}>
            <div className={styles.syncMessage}>Sync interrupted</div>
            <div className={styles.syncFootnote}>Reload the page to retry.</div>
          </div>
        ) : (
          <div className={styles.syncBlock}>
            <div className={styles.syncMessage}>Loading your private balance</div>
            <div className={styles.syncPct}>{syncPct}%</div>
            <div
              className={styles.syncBarTrack}
              role="progressbar"
              aria-valuenow={syncPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Shielded balance sync progress"
            >
              <div className={styles.syncBarFill} style={{ width: `${syncPct}%` }} />
            </div>
            <div className={styles.syncFootnote}>
              Subsequent visits will be much faster.
            </div>
          </div>
        )
      ) : (
        <>
          {isSyncing ? (
            <div className={styles.syncing}>Syncing…</div>
          ) : (
            <div className={styles.total}>{formatUsdcAmount(total)}</div>
          )}
          <div className={styles.available}>
            {isSyncing ? '— available' : `${formatUsdcAmount(displayBalance)} available`}
          </div>
          <Button
            variant="gradient"
            size="lg"
            label="Deposit"
            showIcon={false}
            className={styles.depositButton}
            onClick={() => openActionModal('shield')}
          />
        </>
      )}
    </Card>
  )
}
