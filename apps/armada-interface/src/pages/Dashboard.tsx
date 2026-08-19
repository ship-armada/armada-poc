// ABOUTME: Dashboard page — centered Private-USDC BalanceCard + deposit tooltip + recent activity.
// ABOUTME: Presentation from the armada-app mockup; wired to real shielded balance, yield, and tx history.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChartBarIcon } from '@heroicons/react/24/outline'
import { BalanceCard } from '@/components/dashboard/BalanceCard'
import { DepositTooltip } from '@/components/dashboard/DepositTooltip'
import { DASHBOARD_TOOLTIP_ENTER_DELAY_MS } from '@/components/dashboard/BalanceCard/balanceRevealMotion'
import { DashboardScrollTopFade } from '@/components/dashboard/DashboardScrollTopFade'
import { RecentActivityList, ActivityAllPanel } from '@/components/dashboard/RecentActivityList'
import { ActivityReceipt } from '@/components/dashboard/ActivityReceipt'
import { txListToActivityItems } from '@/components/dashboard/txActivityAdapter'
import { formatUsdcAmount } from '@/components/dashboard/dashboardFormat'
import type { BalanceRollMode } from '@/components/dashboard/RollingBalanceValue'
import { SyncGate, isInitialSyncGated } from '@/components/sync'
import { usePrivateUsdcDisplay } from '@/hooks/usePrivateUsdcDisplay'
import { useYieldRate } from '@/hooks/useYieldRate'
import { useOpenActionModal } from '@/hooks/useOpenActionModal'
import { sharesToUsdc } from '@/lib/yield'
import { openModalAtom, balanceHiddenAtom } from '@/state/ui'
import { shieldedUsdcAtom, syncStateAtom, yieldSharesAtom, shieldedWalletAtom, evmAddressAtom } from '@/state/wallet'
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
  const evmAddress = useAtomValue(evmAddressAtom)

  // Actions
  const openActionModal = useOpenActionModal()
  const setOpenModal = useSetAtom(openModalAtom)
  const openModal = useAtomValue(openModalAtom)

  // "All activity" side-panel + the per-tx receipt overlay (replaces the retired /history page).
  const [activityPanelOpen, setActivityPanelOpen] = useState(false)
  const [receiptId, setReceiptId] = useState<string | null>(null)

  // Balance visibility is app-wide (shared with the wallet panel's hide toggle) via balanceHiddenAtom.
  const [balanceHidden, setBalanceHidden] = useAtom(balanceHiddenAtom)

  // Balance odometer roll: intro roll from zero on first paint, then roll from the previous value
  // whenever the balance changes (e.g. after a deposit settles). The roll is deferred until no tx
  // modal is open, so it plays on the dashboard rather than behind a modal.
  const balanceNumber = usdcToNumber(displayBalance)
  const [rollTrigger, setRollTrigger] = useState(0)
  const [rollMode, setRollMode] = useState<BalanceRollMode>('fromZero')
  const [rollFromValue, setRollFromValue] = useState<string | undefined>(undefined)
  const [pendingRollFrom, setPendingRollFrom] = useState<string | undefined>(undefined)
  const prevBalanceRef = useRef<number | null>(null)
  useEffect(() => {
    const prev = prevBalanceRef.current
    prevBalanceRef.current = balanceNumber
    if (prev === null || prev === balanceNumber) return
    // Match the card's full-precision display (up to 6 decimals) so the odometer digit counts line up.
    setPendingRollFrom(formatUsdcAmount(prev, 6))
  }, [balanceNumber])
  useEffect(() => {
    if (openModal !== null || pendingRollFrom === undefined) return
    setRollMode('fromValue')
    setRollFromValue(pendingRollFrom)
    setRollTrigger((t) => t + 1)
    setPendingRollFrom(undefined)
  }, [openModal, pendingRollFrom])

  // Derived vault position + activity.
  const earningUsdc =
    yieldShares !== null && yieldRate !== null ? sharesToUsdc(yieldShares, yieldRate.rate) : 0n
  const vaultNumber = usdcToNumber(earningUsdc)
  const vaultApy = yieldRate !== null ? Number(yieldRate.apyBps) / 100 : undefined
  const activityItems = useMemo(
    () => txListToActivityItems(txList, evmAddress),
    [txList, evmAddress],
  )
  const hasCompletedDeposit = txList.some(
    (r) => (r.kind === 'shield' || r.kind === 'shield-xchain') && r.executionState === 'completed',
  )
  const showDepositTooltip = balanceNumber <= 0 && !hasCompletedDeposit
  // Activity shows automatically whenever there are items (the manual hide toggle was dropped in the
  // polish redesign — the more-menu that held it is gone).
  const showActivity = activityItems.length > 0
  // Earn promo banner — nudge users with idle private USDC and no vault position yet to start earning.
  const showEarnBanner =
    !showDepositTooltip && balanceNumber > 0 && vaultNumber <= 0 && vaultApy !== undefined && vaultApy > 0

  // Tooltip/earn-banner enter delay — fades up after the balance card's action row settles.
  const tooltipEnterStyle = {
    '--dashboard-tooltip-enter-delay': `${DASHBOARD_TOOLTIP_ENTER_DELAY_MS}ms`,
  } as CSSProperties

  // Gate the dashboard behind the initial shielded-balance sync. The navbar (AppLayout) stays visible.
  if (isInitialSyncGated(shielded, sync.status)) {
    return <SyncGate />
  }

  return (
    <div className={styles.page}>
      <DashboardScrollTopFade enabled={showActivity} />
      <div className={styles.cardStack}>
        <BalanceCard
          balance={balanceNumber}
          balanceRollTrigger={rollTrigger}
          balanceRollMode={rollMode}
          balanceRollFromValue={rollFromValue}
          vaultBalance={vaultNumber}
          vaultApy={vaultApy}
          armadaAddress={shieldedWallet.shieldedAddress}
          balanceHidden={balanceHidden}
          onBalanceHiddenChange={setBalanceHidden}
          onSend={() => openActionModal('payment')}
          onDeposit={() => openActionModal('shield')}
          onRequest={() => setOpenModal('receive')}
          onEarn={() => openActionModal('yield-deposit')}
          onVaultOpen={() => openActionModal('yield-deposit')}
        />

        {showDepositTooltip ? (
          <div className={styles.tooltipEnter} style={tooltipEnterStyle}>
            <DepositTooltip stretch onDeposit={() => openActionModal('shield')} />
          </div>
        ) : null}

        {showEarnBanner ? (
          <div className={styles.tooltipEnter} style={tooltipEnterStyle}>
            <DepositTooltip
              stretch
              BadgeIcon={ChartBarIcon}
              badgeBackground="white"
              iconTileTone="purple"
              headline={`Earn ~${(vaultApy ?? 0).toFixed(1)}% APY`}
              body="Deposit into the vault and start earning now."
              infoTooltip="The APY is an estimate from recent vault performance."
              ariaLabel={`Estimated yearly yield ~${(vaultApy ?? 0).toFixed(1)}%`}
              onDeposit={() => openActionModal('yield-deposit')}
            />
          </div>
        ) : null}

        {showActivity ? (
          <RecentActivityList
            items={activityItems}
            balanceRevealed={!balanceHidden}
            onViewAll={() => setActivityPanelOpen(true)}
            onItemClick={(item) => setReceiptId(item.id)}
          />
        ) : null}
      </div>

      {/* Full "all activity" panel (View all) + the per-tx receipt overlay — replace the old /history page. */}
      <ActivityAllPanel
        open={activityPanelOpen}
        onClose={() => setActivityPanelOpen(false)}
        items={activityItems}
        balanceRevealed={!balanceHidden}
        onItemClick={(item) => setReceiptId(item.id)}
      />
      <ActivityReceipt
        record={txList.find((record) => record.id === receiptId) ?? null}
        ownWalletAddress={evmAddress ?? undefined}
        open={receiptId !== null}
        onClose={() => setReceiptId(null)}
      />
    </div>
  )
}
