// ABOUTME: Dashboard page — centered Private-USDC BalanceCard + deposit tooltip + recent activity.
// ABOUTME: Presentation from the armada-app mockup; wired to real shielded balance, yield, and tx history.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useNavigate } from 'react-router-dom'
import { BalanceCard } from '@/components/dashboard/BalanceCard'
import { DepositTooltip } from '@/components/dashboard/DepositTooltip'
import { RecentActivityList } from '@/components/dashboard/RecentActivityList'
import { txListToActivityItems } from '@/components/dashboard/txActivityAdapter'
import { formatUsdcAmount } from '@/components/dashboard/dashboardFormat'
import type { BalanceRollMode } from '@/components/dashboard/RollingBalanceValue'
import { SyncGate, isInitialSyncGated } from '@/components/sync'
import { usePrivateUsdcDisplay } from '@/hooks/usePrivateUsdcDisplay'
import { useYieldRate } from '@/hooks/useYieldRate'
import { useOpenActionModal } from '@/hooks/useOpenActionModal'
import { sharesToUsdc } from '@/lib/yield'
import { openModalAtom } from '@/state/ui'
import { shieldedUsdcAtom, syncStateAtom, yieldSharesAtom, shieldedWalletAtom } from '@/state/wallet'
import { activeTxListAtom } from '@/state/tx'
import styles from './Dashboard.module.css'

/** USDC is a 6-decimal bigint; the card renders plain numbers. */
function usdcToNumber(amount: bigint): number {
  return Number(amount) / 1e6
}

export function Dashboard() {
  // Data (all hooks run unconditionally, before the sync gate's early return).
  const shielded = useAtomValue(shieldedUsdcAtom)
  const sync = useAtomValue(syncStateAtom)
  const { displayBalance } = usePrivateUsdcDisplay()
  const yieldShares = useAtomValue(yieldSharesAtom)
  const { rate: yieldRate } = useYieldRate()
  const shieldedWallet = useAtomValue(shieldedWalletAtom)
  const txList = useAtomValue(activeTxListAtom)

  // Actions
  const openActionModal = useOpenActionModal()
  const setOpenModal = useSetAtom(openModalAtom)
  const navigate = useNavigate()

  // Local UI state — hide/reveal balance + activity panel visibility (new dashboard affordances).
  const [balanceHidden, setBalanceHidden] = useState(false)
  const [activityVisible, setActivityVisible] = useState(true)

  // Balance odometer roll: intro roll from zero on first paint, then roll from the previous value
  // whenever the balance changes (e.g. after a deposit settles).
  const balanceNumber = usdcToNumber(displayBalance)
  const [rollTrigger, setRollTrigger] = useState(0)
  const [rollMode, setRollMode] = useState<BalanceRollMode>('fromZero')
  const [rollFromValue, setRollFromValue] = useState<string | undefined>(undefined)
  const prevBalanceRef = useRef<number | null>(null)
  useEffect(() => {
    const prev = prevBalanceRef.current
    prevBalanceRef.current = balanceNumber
    if (prev === null || prev === balanceNumber) return
    setRollMode('fromValue')
    setRollFromValue(formatUsdcAmount(prev))
    setRollTrigger((t) => t + 1)
  }, [balanceNumber])

  // Derived vault position + activity.
  const earningUsdc =
    yieldShares !== null && yieldRate !== null ? sharesToUsdc(yieldShares, yieldRate.rate) : 0n
  const vaultNumber = usdcToNumber(earningUsdc)
  const vaultApy = yieldRate !== null ? Number(yieldRate.apyBps) / 100 : undefined
  const activityItems = useMemo(() => txListToActivityItems(txList), [txList])
  const hasCompletedDeposit = txList.some(
    (r) => (r.kind === 'shield' || r.kind === 'shield-xchain') && r.executionState === 'completed',
  )
  const showDepositTooltip = balanceNumber <= 0 && !hasCompletedDeposit
  const showActivity = activityVisible && activityItems.length > 0

  // Gate the dashboard behind the initial shielded-balance sync. The navbar (AppLayout) stays visible.
  if (isInitialSyncGated(shielded, sync.status)) {
    return <SyncGate />
  }

  return (
    <div className={styles.page}>
      <div className={styles.cardStack}>
        <BalanceCard
          balance={balanceNumber}
          balanceRollTrigger={rollTrigger}
          balanceRollMode={rollMode}
          balanceRollFromValue={rollFromValue}
          vaultBalance={vaultNumber}
          vaultApy={vaultApy}
          armadaAddress={shieldedWallet.shieldedAddress}
          hasActivityItems={activityItems.length > 0}
          activityVisible={activityVisible}
          onToggleActivity={() => setActivityVisible((v) => !v)}
          balanceHidden={balanceHidden}
          onBalanceHiddenChange={setBalanceHidden}
          onSend={() => openActionModal('payment')}
          onDeposit={() => openActionModal('shield')}
          onRequest={() => setOpenModal('receive')}
          onEarn={() => openActionModal('yield-deposit')}
          onWithdraw={() => openActionModal('unshield')}
          onVaultOpen={() => openActionModal('yield-deposit')}
        />

        {showDepositTooltip ? (
          <DepositTooltip onDeposit={() => openActionModal('shield')} />
        ) : null}

        {showActivity ? (
          <RecentActivityList
            items={activityItems}
            balanceRevealed={!balanceHidden}
            onViewAll={() => navigate('/history')}
            onItemClick={() => navigate('/history')}
          />
        ) : null}
      </div>
    </div>
  )
}
