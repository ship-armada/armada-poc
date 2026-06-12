// ABOUTME: Root component for the crowdfund committer app.
// ABOUTME: Renders three header-nav pages: Network, Participate, and My Position.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useStore, useAtomValue } from 'jotai'
import { type JsonRpcProvider } from 'ethers'
import { ConnectButton, useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import {
  createProvider,
  useContractEvents,
  useGraphState,
  useENS,
  AppShell,
  Separator,
  ErrorAlert,
  ErrorBoundary,
  StaleDataBanner,
  CROWDFUND_CONSTANTS,
  formatUsdc,
  formatArm,
  truncateAddress,
  useContractState,
  estimateUserArmAllocation,
  CrowdfundExperience,
  toDashboardParticipantsFromGraph,
  ParticipateFlowModal,
  LastTxChip,
  type LastTx,
  type UserAllocation,
  type UserHopPosition,
  type CrowdfundExperienceLiveData,
  type CrowdfundExperienceMyPositionData,
} from '@armada/crowdfund-shared'
import { Button as ArmadaButton, WalletPillMenu } from '@armada/ui'
import { getExplorerUrl, getHubChainId, getHubRpcUrls, getMaxBlockRange, getPollIntervalMs, getNetworkMode, getIndexerUrl } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import { useWallet } from '@/hooks/useWallet'
import { useEligibility } from '@/hooks/useEligibility'
import { useAllowance } from '@/hooks/useAllowance'
import { useInviteLinks } from '@/hooks/useInviteLinks'
import { ParticipateFlowV2 } from '@/components/ParticipateFlowV2'
import { ClaimFlowV2 } from '@/components/ClaimFlowV2'
import { useInviteSlots } from '@/hooks/useInviteSlots'
import { useBeforeUnloadGuard } from '@/hooks/useBeforeUnloadGuard'
import { abortPipelinesForOtherAddress, applyWatchedTxResult, pipelinesAtom } from '@/hooks/useTxPipeline'
import { usePendingTxWatcher } from '@/hooks/usePendingTxWatcher'
import { PageNav, type Page } from '@/appNav'

/**
 * Map a wagmi connector id to the `walletProvider` slug WalletPillMenu uses to
 * pick the brand icon. Returns undefined for unknown connectors so the menu
 * falls back to its generic wallet glyph.
 */
function detectWalletProvider(connectorId: string | undefined): string | undefined {
  if (!connectorId) return undefined
  const id = connectorId.toLowerCase()
  if (id.includes('metamask')) return 'metamask'
  if (id.includes('phantom')) return 'phantom'
  if (id.includes('walletconnect')) return 'walletconnect'
  return undefined
}

/**
 * RainbowKit-aware wallet chrome. Pre-connect / connecting / wrong-network
 * states render an `@armada/ui` `Button` (so the mobile sheet's `className`
 * override applies). The connected state swaps in the designer's
 * `WalletPillMenu` — provider icon + truncated address pill that expands into
 * a card showing the full address, USDC balance, copy, and disconnect.
 *
 * The connected pill is a CSS-Module primitive that doesn't take a
 * `className`; the `className` prop only forwards to the non-connected
 * fallbacks (where the mobile sheet expects a full-width centered button).
 */
function HeaderWalletButton({
  className,
  usdcBalance,
}: {
  className?: string
  usdcBalance?: bigint
}) {
  const { connector } = useAccount()
  const { disconnect } = useDisconnect()
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        authenticationStatus,
        openChainModal,
        openConnectModal,
      }) => {
        const isReady = mounted && authenticationStatus !== 'loading'
        const isConnected =
          isReady &&
          account &&
          chain &&
          (!authenticationStatus || authenticationStatus === 'authenticated')

        if (!isReady) {
          return (
            <ArmadaButton
              variant="secondary"
              size="md"
              label="Connecting..."
              showIcon={false}
              disabled
              className={className}
            />
          )
        }

        if (!isConnected) {
          return (
            <ArmadaButton
              variant="secondary"
              size="md"
              label="Connect Wallet"
              showIcon={false}
              onClick={openConnectModal}
              className={className}
            />
          )
        }

        if (chain.unsupported) {
          return (
            <ArmadaButton
              variant="secondary"
              size="md"
              label="Wrong network"
              showIcon={false}
              onClick={openChainModal}
              className={className}
            />
          )
        }

        // Mockup convention is 6 chars before the ellipsis ("0x1234...abcd").
        // RainbowKit's `displayName` truncates to 4, so reach through to the
        // raw address. Preserve ENS resolutions (no leading "0x") as-is.
        const displayAddress = account.displayName.startsWith('0x')
          ? truncateAddress(account.address)
          : account.displayName

        // USDC is 6 decimals. WalletPillMenu renders a whole-number label
        // ("123 USDC"), so the sub-cent dust is fine to drop here.
        const balanceWhole = usdcBalance !== undefined ? Number(usdcBalance / 1_000_000n) : 0

        return (
          <WalletPillMenu
            displayAddress={displayAddress}
            copyAddress={account.address}
            walletProvider={detectWalletProvider(connector?.id)}
            usdcBalance={balanceWhole}
            onDisconnect={() => disconnect()}
          />
        )
      }}
    </ConnectButton.Custom>
  )
}


/** Format the Crowdfund hero Progress card's countdown tag from a remaining
 *  duration in seconds. Mirrors the designer's "X DAYS LEFT" / "X HOURS LEFT"
 *  aesthetic exactly, with sane singular vs. plural copy. Returns `null` past
 *  the deadline so the Progress primitive suppresses the tag entirely — the
 *  status pill flips to "CLOSED" via `formatSaleStatusLabel` in that case,
 *  which is the user-facing signal we want without a stale countdown tag. */
function formatRemainingLabel(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const days = Math.floor(seconds / 86400)
  if (days >= 1) return `${days} ${days === 1 ? 'DAY' : 'DAYS'} LEFT`
  const hours = Math.floor(seconds / 3600)
  if (hours >= 1) return `${hours} ${hours === 1 ? 'HOUR' : 'HOURS'} LEFT`
  const minutes = Math.max(1, Math.floor(seconds / 60))
  return `${minutes} MIN LEFT`
}

/** Derive the Progress card's lifecycle status pill from the contract phase
 *  plus window-open state. The "Active" badge in the mockup was hardcoded;
 *  here we map the four real states ('ACTIVE' during the open commit window,
 *  'CLOSED' after the window ends but before finalization, then 'FINALIZED' /
 *  'CANCELLED' once the launch team rules) so the user can tell at a glance
 *  which phase the sale is in. */
function formatSaleStatusLabel(
  phase: number,
  windowOpen: boolean,
): { label: string; dot: 'active' | 'lavender' | 'neutral' | 'warning' } {
  if (phase === 1) return { label: 'FINALIZED', dot: 'lavender' }
  if (phase === 2) return { label: 'CANCELLED', dot: 'warning' }
  if (!windowOpen) return { label: 'CLOSED', dot: 'neutral' }
  return { label: 'ACTIVE', dot: 'active' }
}

type ClaimAvailability =
  | { state: 'available' }
  | { state: 'pending'; reason: string }
  | { state: 'pre-open' }

/** Mirror of the Claim page's gate. Used both to gate tab presentation
 *  ("(soon)" suffix) and to drive the Claim page's empty-state copy. */
function getClaimAvailability(
  phase: number,
  armLoaded: boolean,
  windowEnd: number,
  blockTimestamp: number,
  cappedDemand: bigint,
): ClaimAvailability {
  if (!armLoaded && phase === 0) return { state: 'pre-open' }
  if (phase === 1) return { state: 'available' } // finalized
  if (phase === 2) return { state: 'available' } // cancelled (refunds)

  // phase 0
  const windowEnded = windowEnd > 0 && blockTimestamp > windowEnd
  const belowMin = cappedDemand < CROWDFUND_CONSTANTS.MIN_SALE
  if (windowEnded && belowMin) return { state: 'available' } // refund eligibility
  if (windowEnded) return { state: 'pending', reason: 'Awaiting finalization' }
  return { state: 'pending', reason: 'Opens after the campaign window ends' }
}

/** Map contract state to the lifecycle banner's stage. */
function deriveLifecycleStage(
  phase: number,
  windowEnd: number,
  blockTimestamp: number,
  claimDeadline: number,
): 'commit-invite' | 'claim' | 'complete' {
  if (phase === 1 && claimDeadline > 0 && blockTimestamp > claimDeadline) return 'complete'
  if (phase === 1 || phase === 2) return 'claim'
  // phase 0
  if (windowEnd > 0 && blockTimestamp > windowEnd) return 'claim'
  return 'commit-invite'
}

/** Map the `?view=` query param to a page. Drives deep links like the
 *  post-invite "View your position" button (`/?view=myposition`). */
function pageFromViewParam(): Page | null {
  if (typeof window === 'undefined') return null
  switch (new URLSearchParams(window.location.search).get('view')) {
    case 'myposition':
      return 'my-position'
    case 'claim':
      return 'claim'
    case 'network':
      return 'network'
    default:
      return null
  }
}

export function App() {
  // Mock-mode selection now happens in main.tsx, so App() has no early return
  // before its hooks — they run unconditionally (no rules-of-hooks violation).
  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [page, setPage] = useState<Page>(() => pageFromViewParam() ?? 'network')
  // Keep `page` in sync with back/forward navigation that changes `?view=`.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const onPopState = () => {
      const next = pageFromViewParam()
      if (next) setPage(next)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  // Phase 6 — v2 Participate flow runs as a modal overlay; v1 fallback still
  // uses the dedicated `?page=participate` page. `openParticipate()` routes
  // based on the active design flag.
  const [participateOpen, setParticipateOpen] = useState(false)
  // True while the participate pipeline is in flight — gates modal close confirm.
  const [participateRunning, setParticipateRunning] = useState(false)
  // Warn before a refresh/tab-close drops the user while a commit is broadcasting.
  useBeforeUnloadGuard(participateRunning)

  const pollInterval = getPollIntervalMs()
  const indexerUrl = getIndexerUrl()

  // Load deployment
  useEffect(() => {
    loadDeployment()
      .then((d) => {
        setDeployment(d)
        setProvider(createProvider(getHubRpcUrls()))
      })
      .catch((err) => {
        setDeployError(err instanceof Error ? err.message : 'Failed to load deployment')
      })
  }, [])

  const crowdfundAddress = deployment?.contracts.crowdfund ?? null
  const usdcAddress = deployment?.contracts.usdc ?? null
  const armTokenAddress = deployment?.contracts.armToken ?? null

  // Shared data layer
  const { events, loading: eventsLoading, indexerHealth, ingestReceiptLogs, backfill } = useContractEvents({
    provider,
    contractAddress: crowdfundAddress,
    pollIntervalMs: pollInterval,
    startBlock: deployment?.deployBlock,
    chainId: getHubChainId(),
    maxBlockRange: getMaxBlockRange(),
    indexerBaseUrl: indexerUrl,
  })
  const { summaries, nodes } = useGraphState()
  const contractState = useContractState(provider, crowdfundAddress, pollInterval)
  // ENS resolver (kept addresses dep stable via memo).
  const addresses = useMemo(() => [...summaries.keys()], [summaries])
  useENS({ provider, addresses })
  const summaryArray = useMemo(() => [...summaries.values()], [summaries])

  // RainbowKit's programmatic connect-modal opener. Wired to the
  // MyPositionEmptyState's "Connect wallet" CTA below.
  const { openConnectModal } = useConnectModal()

  // Phase 4b.2 — project the live graph into the CrowdfundExperience liveData
  // shape. `loading` covers the initial fetch (no successful event load yet);
  // `ready` is emitted as soon as events are available, even if the resulting
  // participant set is empty (pre-launch). The empty-but-ready case falls
  // through to HeroParticipantsPanel's built-in "be the first" copy.
  //
  // `totalCommitted` is the contract's `getEstimatedCappedDemand().globalCapped`
  // (stored on `contractState.cappedDemand`). This is the on-chain authoritative
  // capped demand — the demand that actually counts toward MIN_SALE. We
  // intentionally DO NOT sum graph dashRow amounts here, because:
  //   - The Crowdfund contract accepts over-cap deposits and refunds the excess
  //     at finalization (see ArmadaCrowdfund.sol _escrowCommit + the "over-cap
  //     deposits are accepted" comment at the top of commit()).
  //   - Summing rawDeposited would over-count by the refund-bound portion;
  //     summing graph-clamped values matches the contract only when the local
  //     HOP_CONFIGS profile happens to match the deployed caps. Reading
  //     getEstimatedCappedDemand() removes that profile-drift class of bug.
  //
  // `daysLeftLabel` derives the Progress card's countdown tag from the
  // contract's commit window — replaces the Progress primitive's hardcoded
  // "3 DAYS LEFT" default. Uppercased to match the designer's tag styling.
  // Participant rows are O(N) to build — memoize them on the event-derived
  // `summaryArray` ONLY, so a 5–15s poll tick (which changes blockTimestamp)
  // doesn't rebuild the array and cascade into CrowdfundExperience / NodeSphere.
  const dashRows = useMemo(
    () => (eventsLoading ? [] : toDashboardParticipantsFromGraph(summaryArray)),
    [eventsLoading, summaryArray],
  )

  // Cheap scalars + labels recompute on the poll tick, but reuse the stable
  // `dashRows` reference above so no O(N) work runs per tick.
  const crowdfundLiveData = useMemo<CrowdfundExperienceLiveData>(() => {
    if (eventsLoading) return { status: 'loading' }
    const totalCommitted = Number(contractState.cappedDemand / 1_000_000n)
    const windowEnd = Number(contractState.windowEnd)
    const remaining = windowEnd - contractState.blockTimestamp
    const daysLeftLabel = formatRemainingLabel(remaining)
    // Inline rather than reading the `windowOpen` const further down — this
    // memo is hoisted above that declaration. Same predicate.
    const liveWindowOpen =
      contractState.armLoaded &&
      contractState.blockTimestamp >= contractState.windowStart &&
      contractState.blockTimestamp <= contractState.windowEnd
    const saleStatus = formatSaleStatusLabel(contractState.phase, liveWindowOpen)
    return {
      status: 'ready',
      dashRows,
      totalCommitted,
      daysLeftLabel,
      saleStatusLabel: saleStatus.label,
      saleStatusDot: saleStatus.dot,
    }
  }, [
    eventsLoading,
    dashRows,
    contractState.cappedDemand,
    contractState.windowEnd,
    contractState.windowStart,
    contractState.blockTimestamp,
    contractState.phase,
    contractState.armLoaded,
  ])

  // Wallet
  const wallet = useWallet()

  // Abort any pipeline left running/paused for a different account when the
  // wallet switches — its in-flight tx still settles, but no stale-signer send
  // fires. (A modal close is a detach/pause, handled by the flow; this is the
  // hard account-change abort.)
  const jotaiStore = useStore()
  useEffect(() => {
    abortPipelinesForOtherAddress(jotaiStore, wallet.address)
  }, [jotaiStore, wallet.address])

  // Wallet-specific hooks
  const eligibility = useEligibility(wallet.address, nodes)
  const allowance = useAllowance(wallet.address, usdcAddress, crowdfundAddress, armTokenAddress, provider, pollInterval)
  const inviteLinks = useInviteLinks(wallet.address, wallet.signer, crowdfundAddress, contractState.blockTimestamp, events)

  // Resume-watch any tx that was broadcast but not yet confirmed — survivors of
  // a reload (persisted in sessionStorage) and txs whose `tx.wait` timed out
  // mid-session — via the fallback provider. On resolution, refresh balances and
  // flip the matching pipeline row to done/reverted (post-timeout watcher).
  const onWatchedTxResolved = useCallback(
    (txHash: string, status: 'pending' | 'confirmed' | 'failed') => {
      void allowance.refresh()
      if (status !== 'pending') {
        applyWatchedTxResult(jotaiStore, txHash, status === 'confirmed' ? 'confirmed' : 'reverted')
      }
    },
    [allowance, jotaiStore],
  )
  const watchedTxs = usePendingTxWatcher(provider, getHubChainId(), onWatchedTxResolved)
  const pipelines = useAtomValue(pipelinesAtom)
  // A single header chip: prefer an unresolved watched tx; otherwise nudge to
  // reopen Participate if a pipeline is still live (running/paused) off-screen.
  const lastTxChip = useMemo<LastTx | null>(() => {
    const explorerUrl = getExplorerUrl()
    const pending = watchedTxs.find((t) => t.status === 'pending')
    if (pending) {
      return { status: 'submitted', label: pending.label, hash: pending.txHash, explorerUrl, timestamp: 0 }
    }
    const pipe = wallet.address ? pipelines[wallet.address] : undefined
    if (pipe && (pipe.phase === 'running' || pipe.phase === 'paused')) {
      return {
        status: 'submitted',
        label: 'Transaction in progress — reopen Participate to continue',
        hash: null,
        explorerUrl,
        timestamp: 0,
      }
    }
    return null
  }, [watchedTxs, pipelines, wallet.address])

  // Per-hop invite-slot sections derived from real eligibility + invite-link
  // state. Multi-hop wallets get a section per eligible hop; single-hop
  // wallets get one. Same adapter feeds both the inline (CrowdfundExperience
  // MyPosition view) and standalone (`page === 'invite-slots'`) surfaces.
  const inviteSlots = useInviteSlots(
    eligibility.positions,
    inviteLinks,
    provider,
    wallet.signer,
    crowdfundAddress,
    wallet.address,
    events,
    ingestReceiptLogs,
  )

  // Compute the user's personal committed amount (not the global total)
  const userTotalCommitted = useMemo(
    () => eligibility.positions.reduce((sum, p) => sum + p.committed, 0n),
    [eligibility.positions],
  )

  // Is the commitment window open?
  const windowOpen =
    contractState.armLoaded &&
    contractState.blockTimestamp >= contractState.windowStart &&
    contractState.blockTimestamp <= contractState.windowEnd

  // Connected user's projected ARM allocation, used by StatsBar's
  // "Your Allocation" card. Undefined when the user has no positions —
  // the card falls back to a "Connect wallet" placeholder.
  const userAllocation = useMemo((): UserAllocation | undefined => {
    if (!wallet.address || eligibility.positions.length === 0) return undefined
    const positions: UserHopPosition[] = eligibility.positions.map((p) => ({
      hop: p.hop,
      committed: p.committed,
      effectiveCap: p.effectiveCap,
    }))
    return {
      estArmAllocation: estimateUserArmAllocation(
        positions,
        contractState.hopStats,
        contractState.cappedDemand,
        contractState.saleSize,
      ),
      hopCount: eligibility.positions.length,
    }
  }, [
    wallet.address,
    eligibility.positions,
    contractState.hopStats,
    contractState.cappedDemand,
    contractState.saleSize,
  ])

  // Phase 4b.3 — project the connected wallet's primary hop position into the
  // CrowdfundExperience MyPosition discriminated union. Three states:
  //   - disconnected: no wallet → "Connect wallet" empty state
  //   - no-position: wallet but no eligible hop → "Participate" empty state
  //   - ready: wallet + position → live numbers
  const myPositionData = useMemo<CrowdfundExperienceMyPositionData>(() => {
    if (!wallet.address) return { status: 'disconnected' }
    const walletDisplay = truncateAddress(wallet.address)
    // Filter eligibility positions down to the renderable hop range, mapped
    // into the shape `CrowdfundExperienceMyPositionData` expects. Sorted
    // ascending so `positions[0]` is the primary (smallest) hop.
    const renderablePositions = eligibility.positions
      .filter((p) => p.hop === 0 || p.hop === 1 || p.hop === 2)
      .map((p) => ({
        hop: p.hop as 0 | 1 | 2,
        committed: p.committed,
        cap: p.effectiveCap,
        invitesReceived: p.invitesReceived,
        invitesAvailable: p.invitesAvailable,
        invitesUsed: p.invitesUsed,
      }))
      .sort((a, b) => a.hop - b.hop)
    const primary = renderablePositions[0]
    if (!primary) return { status: 'no-position', walletDisplay }
    const hop = primary.hop
    const userSummary = summaries.get(wallet.address.toLowerCase())
    // Refund-mode signal: contract flag is canonical post-finalize; pre-
    // finalize we infer it from the closed window + sub-minimum demand so
    // the card stops showing a misleading "ARM allocation" before the
    // launch team calls finalize().
    const windowEnded =
      contractState.windowEnd > 0 &&
      contractState.blockTimestamp > contractState.windowEnd
    const saleBelowMin = contractState.cappedDemand < CROWDFUND_CONSTANTS.MIN_SALE
    const refundMode =
      contractState.refundMode ||
      contractState.phase === 2 ||
      (windowEnded && saleBelowMin)
    // Refund amount: prefer the on-chain post-claim `refundUsdc` from the
    // user's graph summary; otherwise the user's total committed across
    // all hops (full refund when sale falls below min).
    const totalCommittedUsdcAcrossHops = eligibility.positions.reduce(
      (sum, p) => sum + p.committed,
      0n,
    )
    const refundUsdc =
      userSummary?.refundUsdc != null
        ? userSummary.refundUsdc
        : totalCommittedUsdcAcrossHops
    return {
      status: 'ready',
      walletAddress: wallet.address,
      walletDisplay,
      hop,
      committedUsdc: primary.committed,
      capUsdc: primary.cap,
      armAllocation: userAllocation?.estArmAllocation ?? 0n,
      positions: renderablePositions,
      armClaimed: !!userSummary?.armClaimed,
      finalized: contractState.phase === 1,
      refundMode,
      refundUsdc,
      refundClaimed: !!userSummary?.refundClaimed,
      cancelled: contractState.phase === 2,
    }
  }, [
    wallet.address,
    eligibility.positions,
    userAllocation,
    summaries,
    contractState.phase,
    contractState.refundMode,
    contractState.windowEnd,
    contractState.blockTimestamp,
    contractState.cappedDemand,
  ])

  // Claim availability + lifecycle stage — drive the Claim page state and
  // the persistent lifecycle banner shown above every page.
  const claimAvailability = useMemo(
    () =>
      getClaimAvailability(
        contractState.phase,
        contractState.armLoaded,
        contractState.windowEnd,
        contractState.blockTimestamp,
        contractState.cappedDemand,
      ),
    [
      contractState.phase,
      contractState.armLoaded,
      contractState.windowEnd,
      contractState.blockTimestamp,
      contractState.cappedDemand,
    ],
  )

  const lifecycleStage = useMemo(
    () =>
      deriveLifecycleStage(
        contractState.phase,
        contractState.windowEnd,
        contractState.blockTimestamp,
        contractState.claimDeadline,
      ),
    [
      contractState.phase,
      contractState.windowEnd,
      contractState.blockTimestamp,
      contractState.claimDeadline,
    ],
  )

  const lifecycleCountdown = useMemo(() => {
    if (lifecycleStage === 'commit-invite' && contractState.windowEnd > 0) {
      return Math.max(0, contractState.windowEnd - contractState.blockTimestamp)
    }
    if (lifecycleStage === 'claim' && contractState.claimDeadline > 0) {
      return Math.max(0, contractState.claimDeadline - contractState.blockTimestamp)
    }
    return undefined
  }, [
    lifecycleStage,
    contractState.windowEnd,
    contractState.claimDeadline,
    contractState.blockTimestamp,
  ])

  // Error states
  if (deployError) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center space-y-3">
          <h1 className="text-destructive">Deployment Not Found</h1>
          <p className="text-muted-foreground">{deployError}</p>
        </div>
      </div>
    )
  }

  // On a Hero page (Network or My Position), CrowdfundExperience renders with
  // mock data while contract state hydrates — so we skip the loading gate for
  // those views. Other pages (Participate, Claim, Invite Slots) still wait on
  // the deployment before rendering.
  const isHeroPage = page === 'network' || page === 'my-position'

  if ((!deployment || contractState.loading) && !isHeroPage) {
    const backfillPct =
      backfill && backfill.toBlock > backfill.fromBlock
        ? Math.min(
            99,
            Math.round(
              ((backfill.currentBlock - backfill.fromBlock) /
                (backfill.toBlock - backfill.fromBlock)) *
                100,
            ),
          )
        : null
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="">Loading...</div>
          {backfill?.active ? (
            <div className="text-muted-foreground">
              Syncing history…{backfillPct !== null ? ` ${backfillPct}%` : ''}
            </div>
          ) : (
            <div className="text-muted-foreground">
              Connecting to {getNetworkMode()} network
            </div>
          )}
        </div>
      </div>
    )
  }

  // Right-side action buttons, matching the designer's Hero header. Invite,
  // My position, and Claim are ghost buttons grouped before the wallet pill;
  // Participate is a gradient CTA on the far right. Claim swaps in when the
  // claim phase is open, mirroring the mockup's `claimAvailable` toggle.
  const claimReady = claimAvailability.state === 'available'
  const myPositionActive = page === 'my-position'
  // Mirrors @armada/ui Header.module.css `.myPositionActive`: highlight the
  // My position pill when active using the same navitem-active tokens.
  const myPositionActiveStyle: React.CSSProperties | undefined = myPositionActive
    ? {
        background: 'var(--semantic-component-navitem-active-bg)',
        color: 'var(--semantic-component-navitem-active-text)',
      }
    : undefined

  // Phase 6 — open/close helpers for the modal Participate flow. In v2 mode
  // the flow runs as a modal overlay (mounted alongside whichever page the
  // user is on); in v1 mode the legacy dedicated `?page=participate` page
  // still renders, so we fall back to `setPage('participate')` there.
  //
  // Phase 7 — once the commit window closes, the on-chain `commit()` and
  // `commitWithInvite()` calls revert. We short-circuit the opener as a
  // defensive guard so a stale event handler (or a deep link fired mid-flight)
  // can't drop the user into a modal whose only outcome is a wallet error.
  // The hero / header CTAs that drive this are also hidden via
  // `participationEnabled` below; this is belt-and-braces.
  const openParticipate = () => {
    if (!windowOpen) return
    setParticipateOpen(true)
  }
  const closeParticipate = () => setParticipateOpen(false)

  const headerRightChrome = (
    <div className="flex items-center gap-3">
      <ArmadaButton
        variant="ghost"
        size="md"
        label="My position"
        showIcon={false}
        onClick={() => setPage('my-position')}
        style={myPositionActiveStyle}
      />
      {claimReady && (
        <ArmadaButton
          variant="ghost"
          size="md"
          label="Claim"
          showIcon={false}
          onClick={() => setPage('claim')}
        />
      )}
      <LastTxChip override={lastTxChip} />
      <HeaderWalletButton usdcBalance={allowance.balance} />
      {!claimReady && windowOpen && (
        <ArmadaButton
          variant="gradient"
          size="md"
          label="Participate"
          showIcon
          icon="arrow-right-micro"
          onClick={openParticipate}
        />
      )}
    </div>
  )

  const mobileMenu = (
    <div className="flex flex-col gap-3">
      <PageNav current={page} onChange={setPage} orientation="vertical" />
      <Separator />
      {wallet.connected ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Balance</span>
          <span>{formatUsdc(allowance.balance)}</span>
          {allowance.armBalance > 0n && (
            <span className="text-muted-foreground">
              {formatArm(allowance.armBalance)} ARM
            </span>
          )}
          <Separator className="my-2" />
        </div>
      ) : null}
      <HeaderWalletButton className="w-full justify-center" usdcBalance={allowance.balance} />
    </div>
  )

  const headerNav = <PageNav current={page} onChange={setPage} />

  const participateModal = (
    <ParticipateFlowModal
      open={participateOpen}
      onClose={closeParticipate}
      ariaLabel="Participate in the Armada crowdfund"
      confirmBeforeClose={participateRunning}
    >
      {participateOpen && (
        <ParticipateFlowV2
          // Remount on account switch so mount-frozen baselines can't mix accounts.
          key={wallet.address ?? 'disconnected'}
          onRunningChange={setParticipateRunning}
          eventsLoading={eventsLoading}
          walletConnected={wallet.connected}
          walletAddress={wallet.address}
          signer={wallet.signer}
          positions={eligibility.positions}
          balance={allowance.balance}
          needsApproval={allowance.needsApproval}
          refreshAllowance={allowance.refresh}
          crowdfundAddress={crowdfundAddress}
          usdcAddress={usdcAddress}
          hopStats={contractState.hopStats}
          saleSize={contractState.saleSize}
          cappedDemand={contractState.cappedDemand}
          windowOpen={windowOpen}
          onGoToMyPosition={() => {
            closeParticipate()
            setPage('my-position')
          }}
          onGoToNetwork={() => {
            closeParticipate()
            setPage('network')
          }}
          inviteSlotSections={inviteSlots.empty ? undefined : inviteSlots.sections}
          onReceiptLogs={ingestReceiptLogs}
        />
      )}
    </ParticipateFlowModal>
  )

  // Hero shell — AppShell renders the single chrome header (via AppHeader);
  // CrowdfundExperience renders the full-bleed body with its own header slot
  // suppressed. Controlled `view` syncs to the committer's `page` state;
  // transitions inside CrowdfundExperience notify back via `onViewChange`.
  if (isHeroPage) {
    return (
      <>
        <AppShell
          appName="Committer"
          network={getNetworkMode()}
          headerNav={headerNav}
          headerRight={headerRightChrome}
          mobileMenu={mobileMenu}
          bare
        >
          <CrowdfundExperience
            view={page === 'my-position' ? 'myposition' : 'crowdfund'}
            onViewChange={(next) =>
              setPage(next === 'myposition' ? 'my-position' : 'network')
            }
            header={null}
            inviteSlotSections={inviteSlots.empty ? undefined : inviteSlots.sections}
            liveData={crowdfundLiveData}
            myPositionData={myPositionData}
            connectedAddress={wallet.address ?? undefined}
            onConnectWallet={openConnectModal}
            onParticipate={openParticipate}
            // Hide the Participate CTA (and the My Position invite card) once
            // the sale's outcome is fixed — finalized, cancelled by the
            // security council, or window-closed-pending-finalize all collapse
            // to "the sale is over, no more commits". `windowOpen` already
            // returns false for the first and third cases; `phase !== 2`
            // catches the cancellation path even when cancellation lands
            // mid-window.
            participationEnabled={windowOpen && contractState.phase !== 2}
            etherscanBaseUrl={getExplorerUrl()}
          />
        </AppShell>
        {participateModal}
      </>
    )
  }

  return (
    <>
    <AppShell
      appName="Committer"
      network={getNetworkMode()}
      headerNav={headerNav}
      headerRight={headerRightChrome}
      mobileMenu={mobileMenu}
    >
     <ErrorBoundary>
      <div className="container mx-auto p-4 space-y-4">
        <StaleDataBanner indexerHealth={indexerHealth} />
        {wallet.error && <ErrorAlert>{wallet.error}</ErrorAlert>}

        {page === 'claim' && (
          <div key="page-claim" className="animate-page-enter">
            <ErrorBoundary>
              <ClaimFlowV2
                // Remount on account switch so one account's claim state
                // (hasClaimed, allocation) can't show under another.
                key={wallet.address ?? 'disconnected'}
                walletConnected={wallet.connected}
                walletAddress={wallet.address}
                signer={wallet.signer}
                provider={provider}
                crowdfundAddress={crowdfundAddress}
                phase={contractState.phase}
                refundMode={contractState.refundMode}
                blockTimestamp={contractState.blockTimestamp}
                claimDeadline={contractState.claimDeadline}
                totalCommitted={userTotalCommitted}
                windowEnd={contractState.windowEnd}
                cappedDemand={contractState.cappedDemand}
                claimAvailable={claimAvailability.state === 'available'}
                claimCountdownSeconds={lifecycleCountdown}
                onGoToMyPosition={() => setPage('my-position')}
                onGoToNetwork={() => setPage('network')}
                onReceiptLogs={ingestReceiptLogs}
                refreshAllowance={allowance.refresh}
              />
            </ErrorBoundary>
          </div>
        )}

      </div>
     </ErrorBoundary>
    </AppShell>
    {participateModal}
    </>
  )
}
