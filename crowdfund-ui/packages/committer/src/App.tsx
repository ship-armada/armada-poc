// ABOUTME: Root component for the crowdfund committer app.
// ABOUTME: Renders three header-nav pages: Network, Participate, and My Position.

import { useCallback, useState, useEffect, useMemo, type ReactNode } from 'react'
import { type JsonRpcProvider } from 'ethers'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { ArrowRight, ChevronDown, GitBranch, Loader2, UserPlus, Wallet } from 'lucide-react'
import colorCircleIcon from '../../shared/src/assets/color_circle.svg'
import {
  Button,
  createProvider,
  useContractEvents,
  useGraphState,
  useSelection,
  useENS,
  StatsBar,
  TableView,
  SearchBar,
  TreeView,
  AppShell,
  LastTxChip,
  LifecycleBanner,
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
  EmptyState,
  ErrorAlert,
  ErrorBoundary,
  StaleDataBanner,
  WhatsNextCard,
  CROWDFUND_CONSTANTS,
  formatCountdown,
  formatUsdc,
  formatArm,
  generateMockGraph,
  useContractState,
  cn,
  type ConnectedSummary,
} from '@armada/crowdfund-shared'
import { getHubRpcUrls, getPollIntervalMs, getNetworkMode } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import { useWallet } from '@/hooks/useWallet'
import { useEligibility } from '@/hooks/useEligibility'
import { useAllowance } from '@/hooks/useAllowance'
import { useInviteLinks } from '@/hooks/useInviteLinks'
import { CommitTab } from '@/components/CommitTab'
import { InviteTab } from '@/components/InviteTab'
import { ClaimTab } from '@/components/ClaimTab'
import { MyPositionPanel } from '@/components/MyPositionPanel'

type ActionTab = 'commit' | 'invite'
type ParticipateIntent = ActionTab | null
type Page = 'network' | 'participate' | 'claim' | 'my-position'

/**
 * Master switch for the lifecycle progress bar (header strip + mobile body
 * fallback). Currently hidden because the Claim nav suffix surfaces the same
 * countdown more compactly. The component, derivations, and rendering paths
 * stay in the codebase — flip to `true` to bring the banner back.
 */
const SHOW_LIFECYCLE_BAR = false

const PAGE_ITEMS: ReadonlyArray<{ id: Page; label: string }> = [
  { id: 'network', label: 'Network' },
  { id: 'participate', label: 'Participate' },
  { id: 'claim', label: 'Claim' },
  { id: 'my-position', label: 'My Position' },
]

/**
 * Page navigation — renders as header nav on desktop, stacked list on mobile.
 *  Horizontal variant: color-only active state with a 2px primary underline,
 *  mirroring the reference mockup. Vertical variant (mobile sheet) keeps a
 *  subtle bg fill on active since there's no underline room in a stacked list.
 *
 *  `softDisabled` items remain clickable so the destination page can render
 *  its own explanation, but render in a more-muted style with a parenthesized
 *  suffix (e.g. "(20d 13h)" on Claim while the invite window is still open,
 *  "(ended)" on Participate after the window closes). The map's value is the
 *  literal suffix text — pass an empty string to mute without a suffix.
 */
function PageNav({
  current,
  onChange,
  orientation = 'horizontal',
  softDisabled,
}: {
  current: Page
  onChange: (p: Page) => void
  orientation?: 'horizontal' | 'vertical'
  /** Pages that are present but not yet (or no longer) actionable, mapped
   *  to the suffix text rendered after the label. */
  softDisabled?: ReadonlyMap<Page, string>
}) {
  const isVertical = orientation === 'vertical'
  return (
    <ul
      className={cn(
        'flex',
        isVertical ? 'flex-col items-stretch gap-1' : 'h-full items-stretch gap-7',
      )}
    >
      {PAGE_ITEMS.map((item) => {
        const active = item.id === current
        const muted = softDisabled?.has(item.id) ?? false
        const suffix = softDisabled?.get(item.id)
        return (
          <li key={item.id} className={cn(!isVertical && 'flex h-full')}>
            <button
              type="button"
              onClick={() => onChange(item.id)}
              aria-current={active ? 'page' : undefined}
              aria-disabled={muted ? 'true' : undefined}
              className={cn(
                'text-sm font-medium transition-colors hover:text-foreground',
                isVertical
                  ? cn(
                      'w-full rounded-md px-3 py-1.5 text-left',
                      active ? 'bg-muted/60 text-foreground' : 'text-muted-foreground',
                      muted && !active && 'opacity-60',
                    )
                  : cn(
                      'relative flex h-full items-center px-0 text-[12px] font-semibold leading-none tracking-[0.01em]',
                      active
                        ? 'text-primary after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-primary'
                        : muted
                        ? 'text-muted-foreground/60'
                        : 'text-muted-foreground',
                    ),
              )}
            >
              {item.label}
              {muted && suffix && (
                <span className="ml-1 text-[10px] tracking-wide tabular-nums opacity-80">
                  ({suffix})
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function HeaderWalletButton({ className }: { className?: string }) {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        authenticationStatus,
        openAccountModal,
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
            <button
              type="button"
              className={cn(
                'inline-flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-card/70 px-3 text-xs font-semibold text-muted-foreground shadow-sm',
                className,
              )}
              disabled
            >
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Wallet
            </button>
          )
        }

        if (!isConnected) {
          return (
            <button
              type="button"
              className={cn(
                'inline-flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-card/80 px-3 text-xs font-semibold text-muted-foreground shadow-sm transition-colors hover:border-primary/45 hover:bg-card hover:text-foreground',
                className,
              )}
              onClick={openConnectModal}
            >
              <img
                src={colorCircleIcon}
                alt=""
                className="size-[18px] rounded-full"
                aria-hidden="true"
              />
              Connect Wallet
            </button>
          )
        }

        if (chain.unsupported) {
          return (
            <button
              type="button"
              className={cn(
                'inline-flex h-8 items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/15',
                className,
              )}
              onClick={openChainModal}
            >
              Wrong network
            </button>
          )
        }

        return (
          <button
            type="button"
            className={cn(
              'inline-flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-card/80 px-3 text-xs font-semibold text-muted-foreground shadow-sm transition-colors hover:border-primary/45 hover:bg-card hover:text-foreground',
              className,
            )}
            onClick={openAccountModal}
          >
            <img
              src={colorCircleIcon}
              alt=""
              className="size-[18px] rounded-full"
              aria-hidden="true"
            />
            <span className="tabular-nums">{account.displayName}</span>
            <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
          </button>
        )
      }}
    </ConnectButton.Custom>
  )
}

function PageWithHelp({
  children,
  aside,
}: {
  children: ReactNode
  aside?: ReactNode
}) {
  return (
    <div className="relative mx-auto w-full max-w-6xl">
      <div className="mx-auto w-full max-w-2xl space-y-3">
        {children}
      </div>
      {aside && (
        <aside className="mx-auto mt-3 w-full max-w-2xl xl:absolute xl:left-[calc(50%+22rem)] xl:top-0 xl:mt-0 xl:w-56">
          {aside}
        </aside>
      )}
    </div>
  )
}

/**
 * Dev-only stress-test mode — mirrors the committer's 3:2 observer+action
 * grid against a synthetic CrowdfundGraph. Enabled via `?mock=stressN`.
 *
 * The action panel is rendered in a "whitelisted participant" visual state
 * (enabled tab strip + per-tab placeholder content), but none of the
 * Commit/Invite/Claim interactions run — a real signer, provider, and
 * contract state would be needed. A fake `connectedAddress` is picked from
 * the first hop-1 node so the tree's "My wallet" zoom has a target.
 */
function MockCommitterApp({ size }: { size: number }) {
  const graph = useMemo(() => generateMockGraph(size), [size])
  const summaryArray = useMemo(() => [...graph.summaries.values()], [graph])
  const mockConnectedAddress = useMemo(() => {
    // Prefer a hop-1 address — that's the typical "whitelisted participant".
    for (const s of graph.summaries.values()) {
      if (s.hops.includes(1)) return s.address
    }
    return summaryArray[0]?.address ?? null
  }, [graph, summaryArray])

  const [selectedAddress, setSelectedAddress] = useState<string | null>(null)
  const [hoveredAddress, setHoveredAddress] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [focusRequest, setFocusRequest] = useState<{
    address: string
    tick: number
  } | null>(null)
  const [activeTab, setActiveTab] = useState<ActionTab>('commit')
  const [page, setPage] = useState<Page>('network')
  const resolveENS = useCallback(() => null, [])

  const handleViewInTable = useCallback((addr: string) => {
    setSelectedAddress(addr)
    setFocusRequest((prev) => ({ address: addr, tick: (prev?.tick ?? 0) + 1 }))
  }, [])

  // Stress mode pretends we're mid-commit window: claim shows a fake
  // countdown so the nav matches what live users see.
  const mockSoftDisabled = useMemo<Map<Page, string>>(
    () => new Map<Page, string>([['claim', formatCountdown(13 * 86400 + 4 * 3600)]]),
    [],
  )
  const headerNav = (
    <PageNav current={page} onChange={setPage} softDisabled={mockSoftDisabled} />
  )
  const mobileMenu = (
    <div className="flex flex-col gap-3">
      <PageNav
        current={page}
        onChange={setPage}
        orientation="vertical"
        softDisabled={mockSoftDisabled}
      />
    </div>
  )

  return (
    <AppShell
      appName={`Committer · stress ?mock=stress${size}`}
      network="local"
      headerNav={headerNav}
      headerStatus={
        SHOW_LIFECYCLE_BAR ? (
          <LifecycleBanner stage="commit-invite" countdownSeconds={13 * 86400} compact />
        ) : undefined
      }
      mobileMenu={mobileMenu}
    >
      <div className="container mx-auto p-4 space-y-4">
        <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
          <strong>STRESS MODE</strong> — {graph.summaries.size} synthetic addresses rendered,
          action-panel visuals stubbed as a whitelisted hop-1 participant.
          Interactions are disabled. Remove <code>?mock=…</code> from the URL to exit.
        </div>

        {SHOW_LIFECYCLE_BAR && (
          // Mobile-only fallback for the lifecycle status (sm+ uses the header).
          <div className="sm:hidden">
            <LifecycleBanner stage="commit-invite" countdownSeconds={13 * 86400} />
          </div>
        )}

        {page === 'network' && (
          <div key="mock-page-network" className="space-y-3 animate-page-enter">
            <SearchBar value={searchQuery} onChange={setSearchQuery} />
            <ErrorBoundary>
              <TreeView
                graph={graph}
                selectedAddress={selectedAddress}
                onSelectAddress={setSelectedAddress}
                onHoverAddress={setHoveredAddress}
                onViewInTable={handleViewInTable}
                searchQuery={searchQuery}
                phase={0}
                resolveENS={resolveENS}
                connectedAddress={mockConnectedAddress}
                campaignHeader={
                  <div className="px-1 py-1">
                    <div className="font-heading text-sm font-semibold tracking-tight">
                      Armada Crowdfund
                    </div>
                    <div className="mt-2 flex items-start gap-4 tabular-nums">
                      <div>
                        <div className="text-sm font-semibold text-foreground">
                          $15,000
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Committed
                        </div>
                      </div>
                      <div className="h-8 w-px bg-border/60" aria-hidden="true" />
                      <div>
                        <div className="text-sm font-semibold text-foreground">
                          {graph.summaries.size}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Participants
                        </div>
                      </div>
                      <div className="h-8 w-px bg-border/60" aria-hidden="true" />
                      <div>
                        <div className="text-sm font-semibold text-foreground">13</div>
                        <div className="text-[11px] text-muted-foreground">
                          Days left
                        </div>
                      </div>
                    </div>
                  </div>
                }
                campaignDetailsLink={
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground"
                  >
                    View campaign details
                    <ArrowRight className="size-3" />
                  </button>
                }
                participateCta={
                  <div className="flex flex-col items-stretch gap-6 px-5 py-4 text-center sm:flex-row sm:items-center sm:justify-center sm:gap-0 sm:text-left">
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-foreground">
                        Ready to join this network?
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Participate as an existing node.
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="rounded-[4px] bg-primary/55 px-5 text-white hover:bg-primary/65 sm:ml-16"
                      onClick={() => setPage('participate')}
                    >
                      Participate
                    </Button>
                  </div>
                }
              />
            </ErrorBoundary>
            <ErrorBoundary>
              <TableView
                summaries={summaryArray}
                nodes={graph.nodes}
                selectedAddress={selectedAddress}
                onSelectAddress={setSelectedAddress}
                focusRequest={focusRequest}
                searchQuery={searchQuery}
                phase={0}
                resolveENS={resolveENS}
                hoveredAddress={hoveredAddress}
                connectedAddress={mockConnectedAddress}
              />
            </ErrorBoundary>
          </div>
        )}

        {page === 'participate' && (
          <div key="mock-page-participate" className="mx-auto max-w-2xl space-y-3 animate-page-enter">
            <MockActionPanel
              activeTab={activeTab}
              onTabChange={setActiveTab}
              address={mockConnectedAddress}
            />
            <WhatsNextCard
              steps={[
                { label: 'Commit USDC', status: 'active' },
                { label: 'Invite others (optional)' },
                { label: 'Wait for the campaign window to end' },
                { label: 'Claim your tokens' },
              ]}
            />
          </div>
        )}

        {page === 'claim' && (
          <div key="mock-page-claim" className="mx-auto max-w-2xl space-y-3 animate-page-enter">
            <div className="rounded-lg border border-border bg-card p-6 text-sm shadow-elevated">
              <div className="mb-1 font-medium text-foreground">Claim isn't open yet</div>
              <div className="text-muted-foreground">
                You'll be able to claim ARM tokens (or a USDC refund) after the
                commitment window closes and the sale finalizes.
              </div>
            </div>
            <WhatsNextCard
              steps={[
                { label: 'Commit & invite', status: 'done' },
                { label: 'Window closes', status: 'active' },
                { label: 'Claim your tokens' },
              ]}
            />
          </div>
        )}

        {page === 'my-position' && (
          <div
            key="mock-page-my-position"
            className="mx-auto max-w-2xl rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground shadow-elevated animate-page-enter"
          >
            <div className="mb-2 font-medium text-foreground">My Position</div>
            Wallet-scoped dashboard — coming soon. This page will show your committed total,
            remaining invite slots, hop level, and a mini view of your subtree.
          </div>
        )}
      </div>
    </AppShell>
  )
}

/**
 * Visual-only stand-in for the real commit/invite/claim action panel.
 * Shows a tab strip plus per-tab placeholder content describing what
 * the real panel would do — no interactions.
 */
function MockActionPanel({
  activeTab,
  onTabChange,
  address,
}: {
  activeTab: ActionTab
  onTabChange: (tab: ActionTab) => void
  address: string | null
}) {
  const truncated = address
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : '—'
  return (
    <div className="rounded-lg border border-border bg-card shadow-elevated">
      {/* Header — fake wallet identity so the panel reads as "connected". */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <div className="size-6 rounded-full bg-muted flex items-center justify-center">
          <Wallet className="size-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <div className="text-xs text-muted-foreground">Mock wallet · Hop 1</div>
          <div className="font-mono text-sm">{truncated}</div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as ActionTab)}>
        <TabsList variant="line" className="w-full justify-start border-b border-border">
          {(['commit', 'invite'] as const).map((tab) => (
            <TabsTrigger key={tab} value={tab} className="flex-1 capitalize">
              {tab}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="p-6 space-y-3 text-sm">
        {activeTab === 'commit' && (
          <>
            <div className="font-medium text-foreground">Commit USDC</div>
            <div className="text-muted-foreground leading-relaxed">
              Eligible at Hop 1. In a live session you'd enter a per-hop
              USDC amount, review the pro-rata estimate, approve USDC, and
              submit a commit transaction here.
            </div>
          </>
        )}
        {activeTab === 'invite' && (
          <>
            <div className="font-medium text-foreground">Invite participants</div>
            <div className="text-muted-foreground leading-relaxed">
              Generate an EIP-712 signed invite link or issue a direct
              on-chain invite to a specific address. Slot counts and
              expiration are shown here in live mode.
            </div>
          </>
        )}
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Interactions disabled — no signer or contract state in stress mode.
        </div>
      </div>
    </div>
  )
}

function getMockSizeFromUrl(): number {
  if (typeof window === 'undefined') return 0
  const p = new URLSearchParams(window.location.search).get('mock')
  if (!p) return 0
  const n = parseInt(p.replace(/^stress/, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Determine commit/invite tab enabled state + disabled message. Claim was
 *  promoted to its own page; see `getClaimAvailability` for that gating. */
function getTabState(
  tab: ActionTab,
  phase: number,
  windowOpen: boolean,
  armLoaded: boolean,
  windowEnd: number,
  blockTimestamp: number,
  hasInviteSlots: boolean,
): { enabled: boolean; message: string } {
  const windowEnded = windowEnd > 0 && blockTimestamp > windowEnd

  if (!armLoaded && phase === 0) {
    return { enabled: false, message: 'Not yet open' }
  }
  if (phase === 2) return { enabled: false, message: 'Cancelled' }
  if (phase === 1) return { enabled: false, message: 'Finalized' }

  if (tab === 'commit') {
    if (!windowOpen && windowEnded) return { enabled: false, message: 'Deadline passed' }
    if (!windowOpen) return { enabled: false, message: 'Not yet open' }
    return { enabled: true, message: '' }
  }

  // tab === 'invite'
  if (!windowOpen && windowEnded) return { enabled: false, message: 'Deadline passed' }
  if (!windowOpen) return { enabled: false, message: 'Not yet open' }
  if (!hasInviteSlots) return { enabled: false, message: 'No invite slots' }
  return { enabled: true, message: '' }
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

export function App() {
  const [mockSize] = useState(getMockSizeFromUrl)
  if (mockSize > 0) return <MockCommitterApp size={mockSize} />

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  const [intent, setIntent] = useState<ParticipateIntent>(null)
  const [page, setPage] = useState<Page>('network')

  const pollInterval = getPollIntervalMs()

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
  const { events, loading: eventsLoading } = useContractEvents({
    provider,
    contractAddress: crowdfundAddress,
    pollIntervalMs: pollInterval,
    startBlock: deployment?.deployBlock,
  })
  const { graph, summaries, nodes } = useGraphState()
  const contractState = useContractState(provider, crowdfundAddress, pollInterval)
  const { selectedAddress, selectAddress, searchQuery, setSearchQuery, focusRequest, requestFocus } = useSelection()

  // "View in table" selects the address AND scrolls the table. Plain tree clicks select only.
  const handleViewInTable = (addr: string) => {
    selectAddress(addr)
    requestFocus(addr)
  }

  // ENS
  const addresses = useMemo(() => [...summaries.keys()], [summaries])
  const { resolve: resolveENS } = useENS({ provider, addresses })
  const summaryArray = useMemo(() => [...summaries.values()], [summaries])

  // Wallet
  const wallet = useWallet()

  // Wallet-specific hooks
  const eligibility = useEligibility(wallet.address, nodes)
  const allowance = useAllowance(wallet.address, usdcAddress, crowdfundAddress, armTokenAddress, provider)
  const inviteLinks = useInviteLinks(wallet.address, wallet.signer, crowdfundAddress, contractState.blockTimestamp)

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

  // Connected user summary for StatsBar
  const connectedSummary = useMemo((): ConnectedSummary | undefined => {
    if (!wallet.address || eligibility.positions.length === 0) return undefined
    return {
      totalCommitted: userTotalCommitted,
      hopCount: eligibility.positions.length,
    }
  }, [wallet.address, eligibility.positions, userTotalCommitted])

  // Per-intent enabled state — drives the intent picker on the Participate
  // page and the soft-disabled flag on the participate nav item.
  const hasInviteSlots = eligibility.positions.some((p) => p.invitesAvailable > 0)
  const tabStates = useMemo(() => ({
    commit: getTabState('commit', contractState.phase, windowOpen, contractState.armLoaded, contractState.windowEnd, contractState.blockTimestamp, hasInviteSlots),
    invite: getTabState('invite', contractState.phase, windowOpen, contractState.armLoaded, contractState.windowEnd, contractState.blockTimestamp, hasInviteSlots),
  }), [contractState.phase, windowOpen, contractState.armLoaded, contractState.windowEnd, contractState.blockTimestamp, hasInviteSlots])

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

  // Soft-disabled nav items: present but not actionable yet (Claim before
  // finalization) or no longer actionable (Participate after window end).
  // Map values are the suffix shown after the tab label, e.g. "20d 13h" for
  // Claim while the invite/commit window counts down.
  const softDisabledPages = useMemo<Map<Page, string>>(() => {
    const m = new Map<Page, string>()

    // Claim suffix — prefer the live countdown to invite/commit window
    // close. Falls back to "soon" before the window opens or after it
    // closes but before finalization (when no countdown applies).
    if (claimAvailability.state !== 'available') {
      const windowSecondsLeft =
        contractState.windowEnd > 0 && contractState.blockTimestamp > 0
          ? contractState.windowEnd - contractState.blockTimestamp
          : 0
      const suffix =
        windowSecondsLeft > 0 ? formatCountdown(windowSecondsLeft) : 'soon'
      m.set('claim', suffix)
    }

    // Participate suffix — "ended" once the commit window has closed,
    // "soon" if the campaign hasn't opened yet, otherwise no suffix.
    const participateActive =
      tabStates.commit.enabled || tabStates.invite.enabled
    if (!participateActive) {
      const windowEnded =
        contractState.windowEnd > 0 &&
        contractState.blockTimestamp > contractState.windowEnd
      m.set('participate', windowEnded ? 'ended' : 'soon')
    }

    return m
  }, [
    claimAvailability.state,
    contractState.windowEnd,
    contractState.blockTimestamp,
    tabStates.commit.enabled,
    tabStates.invite.enabled,
  ])

  // Error states
  if (deployError) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center space-y-3">
          <h1 className="text-xl font-bold text-destructive">Deployment Not Found</h1>
          <p className="text-sm text-muted-foreground">{deployError}</p>
        </div>
      </div>
    )
  }

  if (!deployment || contractState.loading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-lg">Loading...</div>
          <div className="text-sm text-muted-foreground">
            Connecting to {getNetworkMode()} network
          </div>
        </div>
      </div>
    )
  }

  const walletChrome = (
    <div className="flex items-center gap-2">
      <LastTxChip />
      <HeaderWalletButton />
    </div>
  )

  const mobileMenu = (
    <div className="flex flex-col gap-3">
      <PageNav
        current={page}
        onChange={setPage}
        orientation="vertical"
        softDisabled={softDisabledPages}
      />
      <Separator />
      {wallet.connected ? (
        <div className="flex flex-col gap-1 text-sm tabular-nums">
          <span className="text-xs text-muted-foreground">Balance</span>
          <span>{formatUsdc(allowance.balance)}</span>
          {allowance.armBalance > 0n && (
            <span className="text-muted-foreground">
              {formatArm(allowance.armBalance)} ARM
            </span>
          )}
          <Separator className="my-2" />
        </div>
      ) : null}
      <HeaderWalletButton className="w-full justify-center" />
      <div className="flex justify-start">
        <LastTxChip />
      </div>
    </div>
  )

  const headerNav = (
    <PageNav current={page} onChange={setPage} softDisabled={softDisabledPages} />
  )

  // Derive "days remaining in commit window" for the inset campaign header.
  // Falls back to 0 before the window is known or after it closes.
  const daysLeft =
    contractState.armLoaded && contractState.windowEnd > 0 && contractState.blockTimestamp > 0
      ? Math.max(0, Math.floor((contractState.windowEnd - contractState.blockTimestamp) / 86400))
      : 0

  const treeCampaignHeader = (
    <div className="px-1 py-1">
      <div className="font-heading text-sm font-semibold tracking-tight">
        Armada Crowdfund
      </div>
      <div className="mt-2 flex items-start gap-4 tabular-nums">
        <div>
          <div className="text-sm font-semibold text-foreground">
            {formatUsdc(contractState.totalCommitted)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            Committed
          </div>
        </div>
        <div className="h-8 w-px bg-border/60" aria-hidden="true" />
        <div>
          <div className="text-sm font-semibold text-foreground">
            {contractState.participantCount}
          </div>
          <div className="text-[11px] text-muted-foreground">
            Participants
          </div>
        </div>
        <div className="h-8 w-px bg-border/60" aria-hidden="true" />
        <div>
          <div className="text-sm font-semibold text-foreground">{daysLeft}</div>
          <div className="text-[11px] text-muted-foreground">
            Days left
          </div>
        </div>
      </div>
    </div>
  )

  // TODO: wire to a campaign-details dialog / route. Placeholder for now.
  const treeCampaignDetailsLink = (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground"
      onClick={() => {
        /* TODO: open campaign details */
      }}
    >
      View campaign details
      <ArrowRight className="size-3" />
    </button>
  )

  const treeParticipateCta = (
    <div className="flex flex-col gap-6 px-5 py-4 text-center sm:flex-row sm:items-center sm:justify-center sm:gap-0 sm:text-left">
      <div className="space-y-1.5">
        <div className="text-sm font-medium text-foreground">
          Ready to join this network?
        </div>
        <div className="text-[11px] text-muted-foreground">
          Participate as an existing node.
        </div>
      </div>
      <Button
        size="sm"
        className="rounded-[4px] bg-primary/55 px-8 text-[13px] text-white hover:bg-primary/65 sm:ml-24"
        onClick={() => setPage('participate')}
      >
        Participate
      </Button>
    </div>
  )

  const networkStats = (
    <ErrorBoundary>
      <StatsBar
        hopStats={contractState.hopStats}
        totalCommitted={contractState.totalCommitted}
        cappedDemand={contractState.cappedDemand}
        saleSize={contractState.saleSize}
        phase={contractState.phase}
        armLoaded={contractState.armLoaded}
        seedCount={contractState.seedCount}
        participantCount={contractState.participantCount}
        windowEnd={contractState.windowEnd}
        blockTimestamp={contractState.blockTimestamp}
        connectedSummary={connectedSummary}
        isLoading={eventsLoading}
      />
    </ErrorBoundary>
  )

  const lifecycleStatus = SHOW_LIFECYCLE_BAR ? (
    <LifecycleBanner
      stage={lifecycleStage}
      countdownSeconds={lifecycleCountdown}
      compact
    />
  ) : undefined

  return (
    <AppShell
      appName="Committer"
      network={getNetworkMode()}
      headerNav={headerNav}
      headerStatus={lifecycleStatus}
      headerRight={walletChrome}
      mobileMenu={mobileMenu}
    >
     <ErrorBoundary>
      <div className="container mx-auto p-4 space-y-4">
        <StaleDataBanner />
        {wallet.error && <ErrorAlert>{wallet.error}</ErrorAlert>}

        {SHOW_LIFECYCLE_BAR && (
          // Mobile-only fallback for the lifecycle status. On sm+ the status
          // lives in the AppShell header (compact form); below that
          // breakpoint the header collapses, so we render the full banner
          // here instead.
          <div className="sm:hidden">
            <LifecycleBanner stage={lifecycleStage} countdownSeconds={lifecycleCountdown} />
          </div>
        )}

        {page === 'network' && (
          <div key="page-network" className="space-y-3 animate-page-enter">
            <SearchBar value={searchQuery} onChange={setSearchQuery} />
            <ErrorBoundary>
              <TreeView
                graph={graph}
                selectedAddress={selectedAddress}
                onSelectAddress={selectAddress}
                onViewInTable={handleViewInTable}
                searchQuery={searchQuery}
                phase={contractState.phase}
                resolveENS={resolveENS}
                connectedAddress={wallet.address}
                isLoading={eventsLoading}
                campaignHeader={treeCampaignHeader}
                campaignDetailsLink={treeCampaignDetailsLink}
                participateCta={treeParticipateCta}
              />
            </ErrorBoundary>
            {networkStats}
            <ErrorBoundary>
              <TableView
                summaries={summaryArray}
                nodes={nodes}
                selectedAddress={selectedAddress}
                onSelectAddress={selectAddress}
                focusRequest={focusRequest}
                searchQuery={searchQuery}
                phase={contractState.phase}
                resolveENS={resolveENS}
                hopStats={contractState.hopStats}
                saleSize={contractState.saleSize}
                connectedAddress={wallet.address}
                isLoading={eventsLoading}
              />
            </ErrorBoundary>
            <div className="text-xs text-muted-foreground text-center">
              {events.length} events loaded {eventsLoading && '(syncing...)'}
            </div>
          </div>
        )}

        {page === 'participate' && (
          <div key="page-participate" className="animate-page-enter">
           <ErrorBoundary>
            <PageWithHelp
              aside={
                <WhatsNextCard
                  title="Next steps"
                  variant="rail"
                  steps={[
                    {
                      label: 'Commit USDC',
                      status: userTotalCommitted > 0n ? 'done' : 'active',
                      detail:
                        userTotalCommitted > 0n
                          ? `You've committed ${formatUsdc(userTotalCommitted)}`
                          : 'Pick a hop and submit your commitment',
                    },
                    {
                      label: 'Invite others (optional)',
                      detail: hasInviteSlots ? 'You have invite slots available' : undefined,
                    },
                    { label: 'Wait for the campaign window to end' },
                    { label: 'Claim ARM or refund' },
                  ]}
                />
              }
            >
            {!wallet.connected ? (
              <div className="rounded-lg border border-border bg-card shadow-elevated">
                <EmptyState
                  icon={Wallet}
                  title="Connect your wallet to participate"
                  description="Commit USDC and issue invites while the campaign window is open."
                  action={<ConnectButton />}
                />
              </div>
            ) : softDisabledPages.has('participate') ? (
              // Window has closed (or hasn't opened yet) — explain instead of vanishing.
              <div className="rounded-lg border border-border bg-card p-6 shadow-elevated">
                <div className="mb-1 text-base font-medium text-foreground">
                  This phase has ended
                </div>
                <div className="text-sm text-muted-foreground">
                  You can no longer commit or invite. Head over to Claim when the
                  sale finalizes to claim your ARM tokens (or a USDC refund if the
                  sale ends below the minimum raise).
                </div>
                <div className="mt-4">
                  <Button size="sm" onClick={() => setPage('claim')}>
                    Go to Claim
                  </Button>
                </div>
              </div>
            ) : intent === null ? (
              // Step 1 of the checkout: choose intent. Sub-flows handle their
              // own internal step state once the user picks one.
              <div className="overflow-hidden rounded-xl border border-border/80 bg-card/80 shadow-elevated ring-1 ring-white/[0.03] backdrop-blur-sm">
                <div className="space-y-5 px-6 py-6">
                  <div>
                    <div className="mb-2 text-lg font-semibold tracking-tight text-foreground">
                      How do you want to participate?
                    </div>

                  </div>
                  <div className="grid grid-cols-1 gap-4">
                    <button
                      type="button"
                      disabled={!eligibility.eligible}
                      onClick={() => setIntent('commit')}
                      className={cn(
                        'group relative flex items-center gap-4 overflow-hidden rounded-lg border border-border/70 bg-background/20 p-4 text-left transition-all',
                        'hover:border-hop-0/70 hover:bg-hop-0/5 hover:shadow-[0_0_24px_rgba(132,80,210,0.10)]',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                        intent === ('commit' as ParticipateIntent)
                          ? 'border-hop-0/80 bg-hop-0/10'
                          : 'border-border/70',
                      )}
                    >
                      <div className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-hop-0/35 bg-hop-0/15 text-hop-0">
                        <UserPlus className="size-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">Commit USDC</div>
                        <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                          {eligibility.eligible
                            ? `Eligible at ${eligibility.positions.length} hop${eligibility.positions.length === 1 ? '' : 's'}`
                            : 'Not eligible — you need an invite first'}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      disabled={!hasInviteSlots}
                      onClick={() => setIntent('invite')}
                      className={cn(
                        'group relative flex items-center gap-4 overflow-hidden rounded-lg border border-border/70 bg-background/20 p-4 text-left transition-all',
                        'hover:border-hop-0/70 hover:bg-hop-0/5 hover:shadow-[0_0_24px_rgba(132,80,210,0.10)]',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    >
                      <div className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-hop-0/35 bg-hop-0/15 text-hop-0">
                        <GitBranch className="size-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">Invite someone</div>
                        <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                          {hasInviteSlots
                            ? 'Send an on-chain invite or share a link'
                            : 'No invite slots available'}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            ) : intent === 'commit' ? (
              <CommitTab
                positions={eligibility.positions}
                eligible={eligibility.eligible}
                balance={allowance.balance}
                needsApproval={allowance.needsApproval}
                refreshAllowance={allowance.refresh}
                signer={wallet.signer}
                crowdfundAddress={crowdfundAddress!}
                usdcAddress={usdcAddress!}
                hopStats={contractState.hopStats}
                saleSize={contractState.saleSize}
                phase={contractState.phase}
                windowOpen={windowOpen}
                resolveENS={resolveENS}
                onBackToIntent={() => setIntent(null)}
              />
            ) : (
              <InviteTab
                positions={eligibility.positions}
                signer={wallet.signer}
                address={wallet.address}
                crowdfundAddress={crowdfundAddress!}
                phase={contractState.phase}
                windowOpen={windowOpen}
                inviteLinks={inviteLinks}
                blockTimestamp={contractState.blockTimestamp}
                nodes={nodes}
                provider={provider}
                onBackToIntent={() => setIntent(null)}
              />
            )}
            </PageWithHelp>
           </ErrorBoundary>
          </div>
        )}

        {page === 'claim' && (
          <div key="page-claim" className="animate-page-enter">
           <ErrorBoundary>
            <PageWithHelp
              aside={
                wallet.connected && claimAvailability.state !== 'available' ? (
                  <WhatsNextCard
                    title="Next steps"
                    variant="rail"
                    steps={[
                      {
                        label: 'Commit & invite',
                        status: lifecycleStage === 'commit-invite' ? 'active' : 'done',
                      },
                      {
                        label: 'Window closes & sale finalizes',
                        status: lifecycleStage === 'commit-invite' ? 'pending' : 'active',
                      },
                      { label: 'Claim ARM or refund' },
                    ]}
                  />
                ) : undefined
              }
            >
            {!wallet.connected ? (
              <div className="rounded-lg border border-border bg-card shadow-elevated">
                <EmptyState
                  icon={Wallet}
                  title="Connect your wallet to claim"
                  description="Once the campaign finalizes you'll be able to claim ARM tokens (or a USDC refund) from here."
                  action={<ConnectButton />}
                />
              </div>
            ) : claimAvailability.state !== 'available' ? (
              // Pre-claim explanation — keeps the page visible so users learn
              // when claim opens, instead of bouncing back to Participate.
              <div className="rounded-lg border border-border bg-card p-6 shadow-elevated">
                <div className="mb-1 text-base font-medium text-foreground">
                  Claiming is not yet available
                </div>
                <div className="text-sm text-muted-foreground">
                  {claimAvailability.state === 'pre-open'
                    ? 'The campaign has not opened yet. Once ARM is loaded and the commitment window closes, you can claim from this page.'
                    : `${claimAvailability.reason}. You'll be able to claim ARM tokens (or a USDC refund if the sale ends below the minimum raise) from here.`}
                </div>
                {lifecycleCountdown !== undefined && lifecycleCountdown > 0 && (
                  <div className="mt-3 text-xs text-muted-foreground tabular-nums">
                    Estimated:{' '}
                    <span className="text-foreground">
                      {formatCountdown(lifecycleCountdown)}
                    </span>
                  </div>
                )}
              </div>
            ) : wallet.address ? (
              <div className="rounded-lg border border-border bg-card p-4 shadow-elevated">
                <ClaimTab
                  address={wallet.address}
                  signer={wallet.signer}
                  provider={provider}
                  crowdfundAddress={crowdfundAddress!}
                  phase={contractState.phase}
                  refundMode={contractState.refundMode}
                  blockTimestamp={contractState.blockTimestamp}
                  claimDeadline={contractState.claimDeadline}
                  totalCommitted={userTotalCommitted}
                  windowEnd={contractState.windowEnd}
                  cappedDemand={contractState.cappedDemand}
                  graph={graph}
                />
              </div>
            ) : null}
            </PageWithHelp>
           </ErrorBoundary>
          </div>
        )}

        {page === 'my-position' && (
          <div key="page-my-position" className="mx-auto w-full max-w-4xl animate-page-enter">
            {!wallet.connected ? (
              <div className="rounded-lg border border-border bg-card shadow-elevated">
                <EmptyState
                  icon={Wallet}
                  title="Connect your wallet to view your position"
                  description="Your committed total, invite slots, hop level, and activity will appear here."
                  action={<ConnectButton />}
                />
              </div>
            ) : (
              <ErrorBoundary>
                <MyPositionPanel
                  address={wallet.address!}
                  positions={eligibility.positions}
                  totalCommitted={userTotalCommitted}
                  graph={graph}
                  events={events}
                  resolveENS={resolveENS}
                  claimAvailable={claimAvailability.state === 'available'}
                  claimCountdown={lifecycleCountdown}
                  onGoToInvite={() => {
                    setIntent('invite')
                    setPage('participate')
                  }}
                  onGoToNetwork={() => setPage('network')}
                  onGoToClaim={() => setPage('claim')}
                />
              </ErrorBoundary>
            )}
          </div>
        )}
      </div>
     </ErrorBoundary>
    </AppShell>
  )
}
