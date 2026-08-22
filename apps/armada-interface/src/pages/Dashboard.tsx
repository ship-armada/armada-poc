// ABOUTME: Dashboard page — centered Private-USDC BalanceCard + deposit tooltip + recent activity.
// ABOUTME: Presentation from the armada-app mockup; wired to real shielded balance, yield, and tx history.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChartBarIcon } from '@heroicons/react/24/outline'
import { BalanceCard } from '@/components/dashboard/BalanceCard'
import { DepositTooltip } from '@/components/dashboard/DepositTooltip'
import {
  DASHBOARD_TOOLTIP_ENTER_DELAY_MS,
  dashboardActivityEnterDelayMs,
} from '@/components/dashboard/BalanceCard/balanceRevealMotion'
import { DashboardScrollTopFade } from '@/components/dashboard/DashboardScrollTopFade'
import { RecentActivityList, ActivityAllPanel } from '@/components/dashboard/RecentActivityList'
import { useDepositTooltipHandoff, useEarnBannerHandoff } from '@/hooks/useEarnBannerHandoff'
import { ActivityReceipt } from '@/components/dashboard/ActivityReceipt'
import { buildActivityItems, type DashboardActivityItem } from '@/components/dashboard/txActivityAdapter'
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
import { requestLinksAtom, requestShareIntentAtom } from '@/state/requestLinks'
import styles from './Dashboard.module.css'

/** USDC is a 6-decimal bigint; the card renders plain numbers. */
function usdcToNumber(amount: bigint): number {
  return Number(amount) / 1e6
}

/** Rows shown in the dashboard's inline activity preview (the "View all" panel shows the rest). */
const ACTIVITY_PREVIEW_MAX = 8
/** Ceiling on the "all activity" panel — rendered without virtualization, so we bound the row count. */
const ACTIVITY_PANEL_MAX = 500

export function Dashboard() {
  // Data (all hooks run unconditionally, before the sync gate's early return).
  const shielded = useAtomValue(shieldedUsdcAtom)
  const sync = useAtomValue(syncStateAtom)
  const { displayBalance } = usePrivateUsdcDisplay()
  const yieldShares = useAtomValue(yieldSharesAtom)
  const { rate: yieldRate } = useYieldRate()
  const shieldedWallet = useAtomValue(shieldedWalletAtom)
  const txList = useAtomValue(activeTxListAtom)
  const requestLinks = useAtomValue(requestLinksAtom)
  const evmAddress = useAtomValue(evmAddressAtom)

  // Actions
  const openActionModal = useOpenActionModal()
  const openModal = useAtomValue(openModalAtom)
  const setOpenModal = useSetAtom(openModalAtom)
  const setShareIntent = useSetAtom(requestShareIntentAtom)

  // "All activity" side-panel + the per-tx receipt overlay (replaces the retired /history page).
  const [activityPanelOpen, setActivityPanelOpen] = useState(false)
  const [receiptId, setReceiptId] = useState<string | null>(null)

  // Click routing: a created-link row re-opens the Request flow at its Share step; every other row
  // opens the per-tx receipt.
  function handleActivityItemClick(item: DashboardActivityItem) {
    if (item.kind === 'requestLink') {
      const link = requestLinks.find((l) => l.requestId === item.requestId)
      if (link) {
        setShareIntent(link)
        setOpenModal('request')
      }
      return
    }
    setReceiptId(item.id)
  }

  // Balance visibility is app-wide (shared with the wallet panel's hide toggle) via balanceHiddenAtom.
  const [balanceHidden, setBalanceHidden] = useAtom(balanceHiddenAtom)

  // Balance odometer roll. The *displayed* balance lags the live atom while a tx modal is open (or
  // while the initial sync gate is up), then advances to the live value together with the roll
  // trigger — so the card holds the OLD number and rolls to the NEW one on return, rather than
  // flashing NEW then rolling. Mirrors the mockup, which defers the whole advance (value + roll)
  // until the user is back on the dashboard.
  const gated = isInitialSyncGated(shielded, sync.status)
  // The vault position depends on yieldRate, which loads from a separate poll (useYieldRate) — later
  // than the wallet scan the sync gate waits on. Only prime the promo-banner handoffs once BOTH the
  // gate has lifted and the vault data has loaded, so the established balance/vault values form the
  // baseline rather than a late 0 → real arrival that flashes a banner in and out.
  const vaultLoaded = yieldShares !== null && yieldRate !== null
  const [handoffReady, setHandoffReady] = useState(false)
  useEffect(() => {
    if (gated || !vaultLoaded) {
      setHandoffReady(false)
      return
    }
    const id = requestAnimationFrame(() => setHandoffReady(true))
    return () => cancelAnimationFrame(id)
  }, [gated, vaultLoaded])
  const liveBalance = usdcToNumber(displayBalance)
  const earningUsdc =
    yieldShares !== null && yieldRate !== null ? sharesToUsdc(yieldShares, yieldRate.rate) : 0n
  const liveVault = usdcToNumber(earningUsdc)
  const vaultApy = yieldRate !== null ? Number(yieldRate.apyBps) / 100 : undefined
  // Both the private balance and the vault position are held while a tx modal is open (or the sync
  // gate is up), then advance together with a single roll trigger on return — so the balance roll,
  // the vault-row grow-in, and the earn-banner handoff all play on the dashboard rather than behind
  // the modal. vaultFromValue is set only when the vault actually moved (earn deposit/withdraw).
  // Mirrors the mockup's applyEarnVisibleBalance.
  const [displayedBalance, setDisplayedBalance] = useState(liveBalance)
  const [displayedVault, setDisplayedVault] = useState(liveVault)
  const [rollTrigger, setRollTrigger] = useState(0)
  const [rollMode, setRollMode] = useState<BalanceRollMode>('fromZero')
  const [rollFromValue, setRollFromValue] = useState<string | undefined>(undefined)
  const [vaultRollFromValue, setVaultRollFromValue] = useState<string | undefined>(undefined)
  const lastLiveRef = useRef<number | null>(null)
  const lastVaultRef = useRef<number>(liveVault)
  // Captures whether the activity list was on screen at the first real (post-sync-gate) dashboard
  // paint. Only that initial paint cascades activity in last; later reveals enter immediately.
  const activityVisibleOnPaintRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (gated || openModal !== null) return
    const balanceChanged = lastLiveRef.current !== liveBalance
    const vaultChanged = lastVaultRef.current !== liveVault
    if (!balanceChanged && !vaultChanged) return
    const firstEstablishment = lastLiveRef.current === null
    lastLiveRef.current = liveBalance
    lastVaultRef.current = liveVault
    // First establishment (the initial reveal) doesn't roll — the intro roll-from-zero handles it.
    if (firstEstablishment) {
      setDisplayedBalance(liveBalance)
      setDisplayedVault(liveVault)
      return
    }
    // Roll-from precision must match each row's display so the odometer settles cleanly: the balance
    // card shows full 6 decimals, the vault row shows 2 (VaultPositionBar's formatUsdcAmount default).
    // Passing 6 for the vault made it spin 6 fraction digits then snap-truncate to 2.
    setRollMode('fromValue')
    setRollFromValue(formatUsdcAmount(displayedBalance, 6))
    setVaultRollFromValue(vaultChanged ? formatUsdcAmount(displayedVault, 2) : undefined)
    setRollTrigger((t) => t + 1)
    setDisplayedBalance(liveBalance)
    setDisplayedVault(liveVault)
  }, [gated, openModal, liveBalance, liveVault, displayedBalance, displayedVault])
  // Full activity list (uncapped) so the panel can show everything up to its ceiling and we can tell
  // whether that ceiling was hit. The dashboard preview + the panel then slice their own views.
  const allActivityItems = useMemo(
    () => buildActivityItems(txList, requestLinks, evmAddress, Infinity),
    [txList, requestLinks, evmAddress],
  )
  const previewActivityItems = useMemo(
    () => allActivityItems.slice(0, ACTIVITY_PREVIEW_MAX),
    [allActivityItems],
  )
  const panelActivityItems = useMemo(
    () => allActivityItems.slice(0, ACTIVITY_PANEL_MAX),
    [allActivityItems],
  )
  // Only surface the "showing latest 500" note when activity actually exceeds the ceiling.
  const activityTruncated = allActivityItems.length > ACTIVITY_PANEL_MAX
  const hasCompletedDeposit = txList.some(
    (r) => (r.kind === 'shield' || r.kind === 'shield-xchain') && r.executionState === 'completed',
  )
  const walletConnected = evmAddress !== null
  // Promo-banner handoff: after a first shield the deposit tooltip holds through the balance roll,
  // then collapses and hands off to the earn banner (and reverses on vault deposit/withdraw), rather
  // than the two banners swapping instantly. See useEarnBannerHandoff.
  const depositTooltipHandoff = useDepositTooltipHandoff(
    walletConnected,
    hasCompletedDeposit,
    displayedBalance,
    handoffReady,
  )
  const earnBannerHandoff = useEarnBannerHandoff(
    walletConnected,
    hasCompletedDeposit,
    displayedVault,
    displayedBalance,
    handoffReady,
  )
  const showDepositTooltip = depositTooltipHandoff.showDepositTooltip
  const depositTooltipPersistVisible = depositTooltipHandoff.depositTooltipPersistVisible
  const depositTooltipExiting = depositTooltipHandoff.depositTooltipExiting
  // Activity shows automatically whenever there are items (the manual hide toggle was dropped in the
  // polish redesign — the more-menu that held it is gone).
  const showActivity = allActivityItems.length > 0
  // Earn promo banner — the two banners are mutually exclusive; earn only shows once the deposit
  // tooltip is gone and the vault pays a real APY. Gated on `handoffReady` so it can't flash during
  // load: yieldRate (→ earnApyAvailable) and the deferred `displayedVault` settle on different renders,
  // so before the dashboard is ready there's a frame where apy looks available while the vault still
  // reads 0 — which would briefly show the banner, then collapse it out.
  const earnApyAvailable = vaultApy !== undefined && vaultApy > 0
  const showEarnBanner =
    handoffReady && earnBannerHandoff.showEarnBanner && !showDepositTooltip && earnApyAvailable
  const earnBannerHandoffEnter =
    earnBannerHandoff.earnBannerHandoffEnter || (showEarnBanner && depositTooltipHandoff.revealEarnBanner)
  const earnBannerPersistVisible = earnBannerHandoff.earnBannerPersistVisible

  // Tooltip/earn-banner enter delay — fades up after the balance card's action row settles.
  const tooltipEnterStyle = {
    '--dashboard-tooltip-enter-delay': `${DASHBOARD_TOOLTIP_ENTER_DELAY_MS}ms`,
  } as CSSProperties

  // Gate the dashboard behind the initial shielded-balance sync. The navbar (AppLayout) stays visible.
  if (gated) {
    return <SyncGate />
  }

  // Page-load cascade: activity enters last, after the hero → actions → banner beats. Captured on the
  // first post-gate paint so activity that appears later (e.g. after a tx) just enters immediately.
  if (activityVisibleOnPaintRef.current === null) {
    activityVisibleOnPaintRef.current = showActivity
  }
  const activityEnterDelayMs = dashboardActivityEnterDelayMs(
    showDepositTooltip || showEarnBanner,
    activityVisibleOnPaintRef.current,
  )
  const activityEnterStyle = {
    '--dashboard-activity-enter-delay': `${activityEnterDelayMs}ms`,
  } as CSSProperties

  return (
    <div className={styles.page}>
      <DashboardScrollTopFade enabled={showActivity} />
      <div className={styles.cardStack}>
        <BalanceCard
          balance={displayedBalance}
          balanceRollTrigger={rollTrigger}
          balanceRollMode={rollMode}
          balanceRollFromValue={rollFromValue}
          vaultBalance={displayedVault}
          vaultRollFromValue={vaultRollFromValue}
          vaultApy={vaultApy}
          armadaAddress={shieldedWallet.shieldedAddress}
          balanceHidden={balanceHidden}
          onBalanceHiddenChange={setBalanceHidden}
          onSend={() => openActionModal('payment')}
          onDeposit={() => openActionModal('shield')}
          onRequest={() => openActionModal('request')}
          onEarn={() => openActionModal('yield-deposit')}
          onVaultOpen={() => openActionModal('yield-deposit')}
        />

        {showDepositTooltip ? (
          <div
            className={[
              styles.cardStackTooltip,
              depositTooltipExiting
                ? styles.tooltipHandoffExit
                : depositTooltipPersistVisible
                  ? styles.tooltipVisible
                  : styles.tooltipEnter,
            ].join(' ')}
            style={depositTooltipPersistVisible || depositTooltipExiting ? undefined : tooltipEnterStyle}
          >
            <div className={styles.cardStackTooltipInner}>
              <DepositTooltip stretch onDeposit={() => openActionModal('shield')} />
            </div>
          </div>
        ) : null}

        <EarnBannerSlot
          show={showEarnBanner}
          handoffEnter={earnBannerHandoffEnter}
          persistVisible={earnBannerPersistVisible}
          tooltipEnterStyle={tooltipEnterStyle}
        >
          <DepositTooltip
            stretch
            BadgeIcon={ChartBarIcon}
            badgeBackground="white"
            iconTileTone="purple"
            headline={`Earn ~${(vaultApy ?? 0).toFixed(1)}% APY`}
            body="Add USDC to Armada's shielded vault and start earning now."
            infoTooltip="The APY is an estimate from recent shielded vault performance."
            ariaLabel={`Estimated yearly yield ~${(vaultApy ?? 0).toFixed(1)}%`}
            onDeposit={() => openActionModal('yield-deposit')}
          />
        </EarnBannerSlot>

        {showActivity ? (
          <div className={styles.activityEnter} style={activityEnterStyle}>
            <RecentActivityList
              items={previewActivityItems}
              balanceRevealed={!balanceHidden}
              onViewAll={() => setActivityPanelOpen(true)}
              onItemClick={handleActivityItemClick}
            />
          </div>
        ) : null}
      </div>

      {/* Full "all activity" panel (View all) + the per-tx receipt overlay — replace the old /history page. */}
      <ActivityAllPanel
        open={activityPanelOpen}
        onClose={() => setActivityPanelOpen(false)}
        items={panelActivityItems}
        truncatedCount={activityTruncated ? ACTIVITY_PANEL_MAX : undefined}
        balanceRevealed={!balanceHidden}
        onItemClick={handleActivityItemClick}
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

/**
 * Earn-banner slot. Owns its own mount lifecycle so it can animate out: it stays mounted after
 * `show` goes false to play the collapse-out, then unmounts. When it enters via a handoff (after a
 * first shield / vault deposit) it grows in with the collapse animation; on a plain page load it uses
 * the delayed fade. `handoffSettled` drops the collapse constraint once the grow-in finishes so the
 * banner sits normally.
 */
function EarnBannerSlot({
  show,
  handoffEnter,
  persistVisible,
  tooltipEnterStyle,
  children,
}: {
  show: boolean
  handoffEnter: boolean
  persistVisible: boolean
  tooltipEnterStyle?: CSSProperties
  children: ReactNode
}) {
  const [rendered, setRendered] = useState(show)
  const [exiting, setExiting] = useState(false)
  const [handoffSettled, setHandoffSettled] = useState(!handoffEnter)

  useEffect(() => {
    if (show) {
      setRendered(true)
      setExiting(false)
      return
    }
    if (!rendered) return
    // Hide requested while on screen — collapse out, then unmount (or unmount immediately if the
    // user prefers reduced motion).
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRendered(false)
      return
    }
    setExiting(true)
  }, [show, rendered])

  useEffect(() => {
    if (!handoffEnter) {
      setHandoffSettled(true)
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setHandoffSettled(true)
      return
    }
    setHandoffSettled(false)
  }, [handoffEnter])

  if (!rendered) return null

  const enterClass = exiting
    ? styles.tooltipHandoffExit
    : handoffEnter
      ? styles.tooltipHandoffEnter
      : persistVisible
        ? styles.tooltipVisible
        : styles.tooltipEnter

  return (
    <div
      className={[
        styles.cardStackTooltip,
        enterClass,
        handoffSettled && !exiting ? styles.tooltipHandoffSettled : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={exiting || handoffEnter || persistVisible ? undefined : tooltipEnterStyle}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return
        if (exiting) {
          setExiting(false)
          setRendered(false)
          return
        }
        setHandoffSettled(true)
      }}
    >
      <div className={styles.cardStackTooltipInner}>{children}</div>
    </div>
  )
}
