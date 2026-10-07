// ABOUTME: Root component for the crowdfund committer app.
// ABOUTME: Renders three header-nav pages: Network, Participate, and My Position.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useStore, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { type JsonRpcProvider } from 'ethers'
import { ConnectButton, useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import {
  createProvider,
  useContractEvents,
  useGraphState,
  useENS,
  AppShell,
  ErrorAlert,
  ErrorBoundary,
  StaleDataBanner,
  formatTimeLeft,
  formatTimeLeftDetail,
  formatOpensAtDetail,
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
import { ObserveDetailsModal } from '@/components/ObserveDetailsModal'
import { CommitterMobileMenu } from '@/components/CommitterMobileMenu'
import { CommitterMobileWallet } from '@/components/CommitterMobileWallet'
import { useInviteSlots } from '@/hooks/useInviteSlots'
import { useBeforeUnloadGuard } from '@/hooks/useBeforeUnloadGuard'
import { abortPipelinesForOtherAddress, applyWatchedTxResult, pipelinesAtom } from '@/hooks/useTxPipeline'
import { usePendingTxWatcher } from '@/hooks/usePendingTxWatcher'
import { localWindowEndUnix, commitWindowSecondsLeft } from '@/lib/windowClock'
import { formatSaleStatusLabel, isPreOpen } from '@/lib/saleStatus'
import { getClaimAvailability, isProjectedRefund } from '@/lib/claimAvailability'
import { shouldDismissClaimModal, CLAIM_CLOSE_CONFIRM_MESSAGE } from '@/lib/claimModal'
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
            // Right-anchor the dropdown: the pill is the header's rightmost item
            // once the Participate CTA is gone (claim period / window closed),
            // so a centered menu would clip past the screen edge.
            align="right"
          />
        )
      }}
    </ConnectButton.Custom>
  )
}


/** Format the Crowdfund hero Progress card's countdown tag from a remaining
 *  duration in seconds. Wraps the shared {@link formatTimeLeft} helper (the
 *  single source of truth for crowdfund "time left", also driving the stats
 *  banner and invite splash) in the designer's uppercase "… LEFT" tag styling.
 *  Returns `null` past the deadline so the Progress primitive suppresses the tag
 *  entirely — the status pill flips to "CLOSED" via `formatSaleStatusLabel` in
 *  that case, which is the user-facing signal we want without a stale tag. */
function formatRemainingLabel(seconds: number): string | null {
  const label = formatTimeLeft(seconds)
  if (!label) return null
  // Under 48h the shared helper returns an HH:MM:SS counter — leave it bare
  // (no "LEFT" suffix) so it reads as a timer rather than a static tag.
  if (seconds < 48 * 60 * 60) return label
  return `${label.toUpperCase()} LEFT`
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

/** Resolve the initial page from the URL. `/observe` and `?view=observe` open
 *  the Details modal over the crowdfund hero (handled separately via
 *  `detailsOpenFromUrl`); they no longer select a dedicated page.
 *  `?view=claim` opens the Claim modal over the hero (see `claimOpenFromUrl`)
 *  and keeps the underlying page on Crowdfund — Claim is never a selected tab. */
function pageFromUrl(): Page | null {
  if (typeof window === 'undefined') return null
  if (window.location.pathname === '/observe') return 'network'
  switch (new URLSearchParams(window.location.search).get('view')) {
    case 'myposition':
      return 'my-position'
    case 'claim':
      return 'network'
    case 'network':
    case 'observe':
      return 'network'
    default:
      return null
  }
}

function claimOpenFromUrl(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('view') === 'claim'
}

function detailsOpenFromUrl(): boolean {
  if (typeof window === 'undefined') return false
  if (window.location.pathname === '/observe') return true
  return new URLSearchParams(window.location.search).get('view') === 'observe'
}

export function App() {
  // Mock-mode selection now happens in main.tsx, so App() has no early return
  // before its hooks — they run unconditionally (no rules-of-hooks violation).
  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [page, setPage] = useState<Page>(() => pageFromUrl() ?? 'network')
  // Keep `page` in sync with back/forward navigation that changes the path or
  // `?view=`.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const onPopState = () => {
      const next = pageFromUrl()
      if (next) setPage(next)
      setDetailsOpen(detailsOpenFromUrl())
      setClaimOpen(claimOpenFromUrl())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  // Phase 6 — v2 Participate flow runs as a modal overlay; v1 fallback still
  // uses the dedicated `?page=participate` page. `openParticipate()` routes
  // based on the active design flag.
  const [participateOpen, setParticipateOpen] = useState(false)
  // Whether the participate modal renders its own X. The commit steps draw a
  // FlowChrome close instead, so the flow reports which steps need ours.
  const [participateModalClose, setParticipateModalClose] = useState(true)
  // Crowdfund Progress "Details" — observe cards in a blurred modal overlay.
  const [detailsOpen, setDetailsOpen] = useState(() => detailsOpenFromUrl())
  // Claim opens as a modal over the hero — never a selected page tab.
  const [claimOpen, setClaimOpen] = useState(() => claimOpenFromUrl())
  // True while the participate pipeline is in flight — gates modal close confirm.
  const [participateRunning, setParticipateRunning] = useState(false)
  // True while a claim tx is in flight — gates the Claim modal's close confirm.
  const [claimRunning, setClaimRunning] = useState(false)
  // Whether the Claim modal renders its own X — only on claim gate screens,
  // which draw no in-card close (mirrors `participateModalClose`).
  const [claimModalClose, setClaimModalClose] = useState(true)
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

  // Local time at which the current block timestamp was observed. Sampled only
  // when a new block timestamp arrives, so the Progress live counter (which
  // ticks on the device clock) stays anchored to chain time between polls.
  const blockObservedAtMs = useMemo(
    () => Date.now(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contractState.blockTimestamp],
  )

  // Cheap scalars + labels recompute on the poll tick, but reuse the stable
  // `dashRows` reference above so no O(N) work runs per tick.
  const crowdfundLiveData = useMemo<CrowdfundExperienceLiveData>(() => {
    if (eventsLoading) return { status: 'loading' }
    const totalCommitted = Number(contractState.cappedDemand / 1_000_000n)
    const windowEnd = Number(contractState.windowEnd)
    const remaining = windowEnd - contractState.blockTimestamp
    const daysLeftLabel = formatRemainingLabel(remaining)
    // Exact-time detail for the countdown tag's hover tooltip — same helper the
    // observer's stats banner uses, so both tooltips read identically.
    const daysLeftTooltip = formatTimeLeftDetail(remaining, windowEnd) || undefined
    // Inline rather than reading the `windowOpen` const further down — this
    // memo is hoisted above that declaration. Same predicate.
    const liveWindowOpen =
      contractState.armLoaded &&
      contractState.blockTimestamp >= contractState.windowStart &&
      contractState.blockTimestamp <= contractState.windowEnd
    const preOpen = isPreOpen(
      contractState.phase,
      contractState.windowStart,
      contractState.blockTimestamp,
    )
    const saleStatus = formatSaleStatusLabel(contractState.phase, liveWindowOpen, preOpen)
    // Before the window opens the countdown targets the opening, not the close.
    // Same chain-to-device-clock anchoring as the close countdown, so it hits
    // zero when chain time reaches windowStart.
    if (preOpen) {
      return {
        status: 'ready',
        dashRows,
        totalCommitted,
        opensAtUnix: localWindowEndUnix(
          contractState.windowStart,
          contractState.blockTimestamp,
          blockObservedAtMs,
        ),
        daysLeftTooltip: formatOpensAtDetail(contractState.windowStart) || undefined,
        saleStatusLabel: saleStatus.label,
        saleStatusDot: saleStatus.dot,
      }
    }
    return {
      status: 'ready',
      dashRows,
      totalCommitted,
      daysLeftLabel,
      ...(windowEnd > 0 && liveWindowOpen
        ? {
            windowEndUnix: localWindowEndUnix(
              windowEnd,
              contractState.blockTimestamp,
              blockObservedAtMs,
            ),
          }
        : {}),
      daysLeftTooltip,
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
    blockObservedAtMs,
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
    (txHash: string, status: 'pending' | 'confirmed' | 'failed', label: string) => {
      void allowance.refresh()
      if (status !== 'pending') {
        applyWatchedTxResult(jotaiStore, txHash, status === 'confirmed' ? 'confirmed' : 'reverted')
      }
      // Surface a reverted tx cross-page. The header chip only renders the
      // in-flight (pending) state and clears on any resolution, so without this
      // a failure that lands while the user is on another page (or after they
      // closed the flow) is otherwise silent. Covers every flow that persists a
      // pending tx (commit, invite, claim).
      if (status === 'failed') {
        const explorerUrl = getExplorerUrl()
        toast.error(`${label} failed`, {
          description: 'The transaction reverted on-chain.',
          duration: 10_000,
          ...(explorerUrl
            ? {
                action: {
                  label: 'View',
                  onClick: () =>
                    window.open(`${explorerUrl}/tx/${txHash}`, '_blank', 'noopener,noreferrer'),
                },
              }
            : {}),
        })
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
  // wallets get one. Same adapter feeds the Your position card (CrowdfundExperience
  // MyPosition view) and the Participate modal's post-commit invite step.
  const inviteSlots = useInviteSlots(
    eligibility.positions,
    inviteLinks,
    provider,
    wallet.signer,
    crowdfundAddress,
    wallet.address,
    events,
    wallet.isWrongNetwork,
    wallet.switchNetwork,
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

  // Before the commit window opens there are no positions yet — Your position
  // is disabled in the nav (and a deep link to it falls back to Crowdfund).
  const preOpen = isPreOpen(
    contractState.phase,
    contractState.windowStart,
    contractState.blockTimestamp,
  )

  // Seconds left in the commit window — shown on the participate splash card.
  // Anchored on the chain block timestamp (same source as the Progress tag and
  // stats banner) and formatted by the shared helper, so every "time left"
  // surface agrees. Undefined until the window/block load so Step0Invite falls
  // back to its placeholder rather than flashing "ENDS TODAY".
  const secondsLeft = commitWindowSecondsLeft(contractState.windowEnd, contractState.blockTimestamp)

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

  // Pre-finalize refund projection from the post-waterfall allocation (see
  // isProjectedRefund). Drives the My Position refund card, the Claim gate and
  // the Claim flow's heads-up, so a determined refund is surfaced before anyone
  // calls finalize().
  const projectedRefund = useMemo(
    () =>
      isProjectedRefund({
        phase: contractState.phase,
        windowEnd: contractState.windowEnd,
        blockTimestamp: contractState.blockTimestamp,
        hopStats: contractState.hopStats,
        cappedDemand: contractState.cappedDemand,
      }),
    [
      contractState.phase,
      contractState.windowEnd,
      contractState.blockTimestamp,
      contractState.hopStats,
      contractState.cappedDemand,
    ],
  )

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
    // finalize we project it from the closed window + post-waterfall
    // allocation so the card stops showing a misleading "ARM allocation"
    // before the launch team calls finalize().
    const refundMode =
      contractState.refundMode ||
      contractState.phase === 2 ||
      projectedRefund
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
    projectedRefund,
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
        projectedRefund,
      ),
    [
      contractState.phase,
      contractState.armLoaded,
      contractState.windowEnd,
      contractState.blockTimestamp,
      projectedRefund,
    ],
  )

  // Claim is disabled in the nav and its modal closed until claim opens.
  const claimReady = claimAvailability.state === 'available'

  // Close an open Claim modal once the loaded state says claim isn't available.
  // Sits above the load-gate early returns below — hooks must run every render.
  const claimStateLoading = contractState.loading
  useEffect(() => {
    if (shouldDismissClaimModal({ open: claimOpen, ready: claimReady, stateLoading: claimStateLoading })) {
      setClaimOpen(false)
    }
  }, [claimOpen, claimReady, claimStateLoading])

  // Leave Your position (e.g. a `?view=myposition` deep link) while the sale
  // hasn't opened. Sits above the load-gate early returns — hooks must run
  // every render.
  useEffect(() => {
    if (preOpen && page === 'my-position') setPage('network')
  }, [preOpen, page])

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

  // Right-side chrome: wallet + Participate CTA. Crowdfund / My position /
  // Claim live in the left PageNav strip; Claim is disabled until claim opens
  // (`claimReady`, above).

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
  const closeParticipate = () => {
    setParticipateOpen(false)
    setParticipateModalClose(true)
  }

  const openClaim = () => {
    if (!claimReady) return
    setParticipateOpen(false)
    setClaimOpen(true)
  }
  const closeClaim = () => {
    setClaimOpen(false)
  }

  const handlePageNav = (next: Page) => {
    if (next === 'claim') {
      openClaim()
      return
    }
    setClaimOpen(false)
    setPage(next)
  }

  const headerRightChrome = (
    <div className="flex items-center gap-3">
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

  const mobileMenu = (close: () => void) => (
    <CommitterMobileMenu
      onClose={close}
      current={page}
      onNavigate={(next) => {
        handlePageNav(next)
      }}
      onParticipate={openParticipate}
      claimAvailable={claimReady}
      myPositionEnabled={!preOpen}
      participationEnabled={windowOpen}
      usdcBalance={allowance.balance}
    />
  )

  const mobileActions = <CommitterMobileWallet usdcBalance={allowance.balance} />

  const headerNav = (
    <PageNav
      current={page}
      onChange={handlePageNav}
      claimEnabled={claimReady}
      myPositionEnabled={!preOpen}
    />
  )

  const participateModal = (
    <ParticipateFlowModal
      open={participateOpen}
      onClose={closeParticipate}
      ariaLabel="Participate in the Armada crowdfund"
      confirmBeforeClose={participateRunning}
      // The commit steps carry their own FlowChrome close; the flow tells us
      // when to fall back to the modal's X (connect, eligibility).
      showClose={participateModalClose}
    >
      {participateOpen && (
        <ParticipateFlowV2
          // Remount on account switch so mount-frozen baselines can't mix accounts.
          key={wallet.address ?? 'disconnected'}
          onRunningChange={setParticipateRunning}
          onModalCloseChange={setParticipateModalClose}
          eventsLoading={eventsLoading}
          secondsLeft={secondsLeft}
          windowEndUnix={Number(contractState.windowEnd)}
          walletConnected={wallet.connected}
          walletAddress={wallet.address}
          signer={wallet.signer}
          provider={provider}
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
          onClose={closeParticipate}
          inviteSlotSections={inviteSlots.sections}
          onReceiptLogs={ingestReceiptLogs}
        />
      )}
    </ParticipateFlowModal>
  )

  const detailsModal = (
    <ObserveDetailsModal
      open={detailsOpen}
      onClose={() => setDetailsOpen(false)}
      state={contractState}
      events={events}
      eventsLoading={eventsLoading}
      provider={provider}
    />
  )

  const claimModal = (
    <ParticipateFlowModal
      open={claimOpen && claimReady}
      onClose={closeClaim}
      ariaLabel="Claim your allocation"
      confirmBeforeClose={claimRunning}
      closeConfirmMessage={CLAIM_CLOSE_CONFIRM_MESSAGE}
      closeAriaLabel="Close claim flow"
      showClose={claimModalClose}
    >
      {claimOpen && claimReady ? (
        <ErrorBoundary>
          <ClaimFlowV2
            // Remount on account switch so one account's claim state
            // (hasClaimed, allocation) can't show under another.
            key={wallet.address ?? 'disconnected'}
            onRunningChange={setClaimRunning}
            onModalCloseChange={setClaimModalClose}
            onClose={closeClaim}
            walletConnected={wallet.connected}
            isWrongNetwork={wallet.isWrongNetwork}
            switchNetwork={wallet.switchNetwork}
            walletAddress={wallet.address}
            signer={wallet.signer}
            provider={provider}
            crowdfundAddress={crowdfundAddress}
            armTokenAddress={armTokenAddress}
            phase={contractState.phase}
            refundMode={contractState.refundMode}
            blockTimestamp={contractState.blockTimestamp}
            claimDeadline={contractState.claimDeadline}
            totalCommitted={userTotalCommitted}
            windowEnd={contractState.windowEnd}
            projectedRefund={projectedRefund}
            claimAvailable={claimAvailability.state === 'available'}
            claimCountdownSeconds={lifecycleCountdown}
            onGoToMyPosition={() => {
              closeClaim()
              setPage('my-position')
            }}
            onGoToNetwork={() => {
              closeClaim()
              setPage('network')
            }}
            onReceiptLogs={ingestReceiptLogs}
            refreshAllowance={allowance.refresh}
          />
        </ErrorBoundary>
      ) : null}
    </ParticipateFlowModal>
  )

  // Hero shell — AppShell renders the single chrome header (via AppHeader);
  // CrowdfundExperience renders the full-bleed body with its own header slot
  // suppressed. Controlled `view` syncs to the committer's `page` state;
  // transitions inside CrowdfundExperience notify back via `onViewChange`.
  // Claim is a modal overlay (never a selected page tab).
  if (isHeroPage) {
    return (
      <>
        <AppShell
          appName="Committer"
          network={getNetworkMode()}
          headerNav={headerNav}
          headerRight={headerRightChrome}
          mobileActions={mobileActions}
          bare
        >
          <CrowdfundExperience
            view={page === 'my-position' ? 'myposition' : 'crowdfund'}
            onViewChange={(next) =>
              setPage(next === 'myposition' ? 'my-position' : 'network')
            }
            header={null}
            inviteSlotSections={inviteSlots.sections}
            liveData={crowdfundLiveData}
            myPositionData={myPositionData}
            connectedAddress={wallet.address ?? undefined}
            onConnectWallet={openConnectModal}
            onParticipate={openParticipate}
            onClaim={openClaim}
            claimAvailable={claimReady}
            onDetails={() => setDetailsOpen(true)}
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
        {claimModal}
        {detailsModal}
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
      </div>
     </ErrorBoundary>
    </AppShell>
    {participateModal}
    {claimModal}
    </>
  )
}
