// ABOUTME: Root component for the crowdfund committer app.
// ABOUTME: Renders three header-nav pages: Network, Participate, and My Position.

import { useCallback, useState, useEffect, useMemo } from 'react'
import { type JsonRpcProvider } from 'ethers'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { ArrowRight, Wallet } from 'lucide-react'
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
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
  EmptyState,
  ErrorAlert,
  ErrorBoundary,
  StaleDataBanner,
  CROWDFUND_CONSTANTS,
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

type ActionTab = 'commit' | 'invite' | 'claim'
type Page = 'network' | 'participate' | 'my-position'

const PAGE_ITEMS: ReadonlyArray<{ id: Page; label: string }> = [
  { id: 'network', label: 'Network' },
  { id: 'participate', label: 'Participate' },
  { id: 'my-position', label: 'My Position' },
]

/** Page navigation — renders as header nav on desktop, stacked list on mobile.
 *  Horizontal variant: color-only active state with a 2px primary underline,
 *  mirroring the reference mockup. Vertical variant (mobile sheet) keeps a
 *  subtle bg fill on active since there's no underline room in a stacked list. */
function PageNav({
  current,
  onChange,
  orientation = 'horizontal',
}: {
  current: Page
  onChange: (p: Page) => void
  orientation?: 'horizontal' | 'vertical'
}) {
  const isVertical = orientation === 'vertical'
  return (
    <ul
      className={cn(
        'flex items-center',
        isVertical ? 'flex-col items-stretch gap-1' : 'gap-6',
      )}
    >
      {PAGE_ITEMS.map((item) => {
        const active = item.id === current
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onChange(item.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'text-sm font-medium transition-colors hover:text-foreground',
                isVertical
                  ? cn(
                      'w-full rounded-md px-3 py-1.5 text-left',
                      active ? 'bg-muted/60 text-foreground' : 'text-muted-foreground',
                    )
                  : cn(
                      'border-b-2 pb-1',
                      active
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground',
                    ),
              )}
            >
              {item.label}
            </button>
          </li>
        )
      })}
    </ul>
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

  const headerNav = <PageNav current={page} onChange={setPage} />
  const mobileMenu = (
    <div className="flex flex-col gap-3">
      <PageNav current={page} onChange={setPage} orientation="vertical" />
    </div>
  )

  return (
    <AppShell
      appName={`Committer · stress ?mock=stress${size}`}
      network="local"
      headerNav={headerNav}
      mobileMenu={mobileMenu}
    >
      <div className="container mx-auto p-4 space-y-4">
        <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
          <strong>STRESS MODE</strong> — {graph.summaries.size} synthetic addresses rendered,
          action-panel visuals stubbed as a whitelisted hop-1 participant.
          Interactions are disabled. Remove <code>?mock=…</code> from the URL to exit.
        </div>

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
                  <div className="rounded-md border border-border bg-card/85 px-4 py-3 shadow-sm backdrop-blur-sm">
                    <div className="font-heading text-sm font-semibold tracking-tight">
                      Armada Crowdfund
                    </div>
                    <div className="mt-2 flex items-start gap-5 tabular-nums">
                      <div>
                        <div className="text-sm font-semibold text-foreground">
                          $15,000
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Committed
                        </div>
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-foreground">
                          {graph.summaries.size}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Participants
                        </div>
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-foreground">13</div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
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
                  <div className="flex flex-col items-stretch gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-medium text-foreground">
                        Ready to join this network?
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Participate as an existing node.
                      </div>
                    </div>
                    <Button size="sm" onClick={() => setPage('participate')}>
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
          <div key="mock-page-participate" className="mx-auto max-w-2xl animate-page-enter">
            <MockActionPanel
              activeTab={activeTab}
              onTabChange={setActiveTab}
              address={mockConnectedAddress}
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
          {(['commit', 'invite', 'claim'] as const).map((tab) => (
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
        {activeTab === 'claim' && (
          <>
            <div className="font-medium text-foreground">Claim ARM / refund</div>
            <div className="text-muted-foreground leading-relaxed">
              After the crowdfund finalizes, claim your allocated ARM
              (with mandatory delegation) or, if the sale ended below the
              minimum raise, claim a full USDC refund.
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

/** Determine tab enabled state and disabled message based on contract phase */
function getTabState(
  tab: ActionTab,
  phase: number,
  windowOpen: boolean,
  armLoaded: boolean,
  windowEnd: number,
  blockTimestamp: number,
  cappedDemand: bigint,
  hasInviteSlots: boolean,
): { enabled: boolean; message: string } {
  const windowEnded = windowEnd > 0 && blockTimestamp > windowEnd
  const belowMin = cappedDemand < CROWDFUND_CONSTANTS.MIN_SALE

  // Pre-open (ARM not loaded)
  if (!armLoaded && phase === 0) {
    return { enabled: false, message: 'Not yet open' }
  }

  // Cancelled
  if (phase === 2) {
    if (tab === 'claim') return { enabled: true, message: '' }
    return { enabled: false, message: 'Cancelled' }
  }

  // Finalized
  if (phase === 1) {
    if (tab === 'claim') return { enabled: true, message: '' }
    return { enabled: false, message: 'Finalized' }
  }

  // Phase 0
  if (tab === 'commit') {
    if (!windowOpen && windowEnded) return { enabled: false, message: 'Deadline passed' }
    if (!windowOpen) return { enabled: false, message: 'Not yet open' }
    return { enabled: true, message: '' }
  }

  if (tab === 'invite') {
    if (!windowOpen && windowEnded) return { enabled: false, message: 'Deadline passed' }
    if (!windowOpen) return { enabled: false, message: 'Not yet open' }
    if (!hasInviteSlots) return { enabled: false, message: 'No invite slots' }
    return { enabled: true, message: '' }
  }

  // Claim tab in phase 0
  if (windowEnded && belowMin) return { enabled: true, message: '' }
  if (windowEnded) return { enabled: false, message: 'Awaiting finalization' }
  return { enabled: false, message: 'Available after finalization' }
}

export function App() {
  const [mockSize] = useState(getMockSizeFromUrl)
  if (mockSize > 0) return <MockCommitterApp size={mockSize} />

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  const [activeTab, setActiveTab] = useState<ActionTab>('commit')
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

  // Tab enabled/disabled states
  const hasInviteSlots = eligibility.positions.some((p) => p.invitesAvailable > 0)
  const tabStates = useMemo(() => ({
    commit: getTabState('commit', contractState.phase, windowOpen, contractState.armLoaded, contractState.windowEnd, contractState.blockTimestamp, contractState.cappedDemand, hasInviteSlots),
    invite: getTabState('invite', contractState.phase, windowOpen, contractState.armLoaded, contractState.windowEnd, contractState.blockTimestamp, contractState.cappedDemand, hasInviteSlots),
    claim: getTabState('claim', contractState.phase, windowOpen, contractState.armLoaded, contractState.windowEnd, contractState.blockTimestamp, contractState.cappedDemand, hasInviteSlots),
  }), [contractState.phase, windowOpen, contractState.armLoaded, contractState.windowEnd, contractState.blockTimestamp, contractState.cappedDemand, hasInviteSlots])

  // Auto-select first enabled tab
  useEffect(() => {
    if (!tabStates[activeTab].enabled) {
      const firstEnabled = (['commit', 'invite', 'claim'] as const).find((t) => tabStates[t].enabled)
      if (firstEnabled) setActiveTab(firstEnabled)
    }
  }, [tabStates, activeTab])

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
    <div className="flex items-center gap-3">
      {wallet.connected && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatUsdc(allowance.balance)}
          {allowance.armBalance > 0n && (
            <> · {formatArm(allowance.armBalance)} ARM</>
          )}
        </span>
      )}
      <LastTxChip />
      <ConnectButton
        showBalance={false}
        chainStatus="icon"
        accountStatus="address"
      />
    </div>
  )

  const mobileMenu = (
    <div className="flex flex-col gap-3">
      <PageNav current={page} onChange={setPage} orientation="vertical" />
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
      <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
      <div className="flex justify-start">
        <LastTxChip />
      </div>
    </div>
  )

  const headerNav = <PageNav current={page} onChange={setPage} />

  // Derive "days remaining in commit window" for the inset campaign header.
  // Falls back to 0 before the window is known or after it closes.
  const daysLeft =
    contractState.armLoaded && contractState.windowEnd > 0 && contractState.blockTimestamp > 0
      ? Math.max(0, Math.floor((contractState.windowEnd - contractState.blockTimestamp) / 86400))
      : 0

  const treeCampaignHeader = (
    <div className="rounded-md border border-border bg-card/85 px-4 py-3 shadow-sm backdrop-blur-sm">
      <div className="font-heading text-sm font-semibold tracking-tight">
        Armada Crowdfund
      </div>
      <div className="mt-2 flex items-start gap-5 tabular-nums">
        <div>
          <div className="text-sm font-semibold text-foreground">
            {formatUsdc(contractState.totalCommitted)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Committed
          </div>
        </div>
        <div>
          <div className="text-sm font-semibold text-foreground">
            {contractState.participantCount}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Participants
          </div>
        </div>
        <div>
          <div className="text-sm font-semibold text-foreground">{daysLeft}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
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
    <div className="flex flex-col items-stretch gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-medium text-foreground">
          Ready to join this network?
        </div>
        <div className="text-xs text-muted-foreground">
          Participate as an existing node.
        </div>
      </div>
      <Button size="sm" onClick={() => setPage('participate')}>
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

  return (
    <AppShell
      appName="Committer"
      network={getNetworkMode()}
      headerNav={headerNav}
      headerRight={walletChrome}
      mobileMenu={mobileMenu}
    >
     <ErrorBoundary>
      <div className="container mx-auto p-4 space-y-4">
        <StaleDataBanner />
        {wallet.error && <ErrorAlert>{wallet.error}</ErrorAlert>}

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
          <div key="page-participate" className="mx-auto w-full max-w-2xl animate-page-enter">
           <ErrorBoundary>
            {!wallet.connected ? (
              <div className="rounded-lg border border-border bg-card shadow-elevated">
                <EmptyState
                  icon={Wallet}
                  title="Connect your wallet to participate"
                  description="Commit USDC, issue invites, and claim ARM once the crowdfund finalizes."
                  action={<ConnectButton />}
                />
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card shadow-elevated">
                <Tabs
                  value={activeTab}
                  onValueChange={(v) => setActiveTab(v as ActionTab)}
                >
                  <TabsList variant="line" className="w-full justify-start border-b border-border rounded-t-lg">
                    {(['commit', 'invite', 'claim'] as const).map((tab) => (
                      <TabsTrigger
                        key={tab}
                        value={tab}
                        disabled={!tabStates[tab].enabled}
                        className="flex-1 capitalize"
                      >
                        {tab}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>

                <div className="p-4">
                  {!tabStates[activeTab].enabled ? (
                    <div className="p-4 text-center text-muted-foreground text-sm">
                      {tabStates[activeTab].message}
                    </div>
                  ) : (
                    <>
                      {activeTab === 'commit' && (
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
                        />
                      )}
                      {activeTab === 'invite' && (
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
                        />
                      )}
                      {activeTab === 'claim' && wallet.address && (
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
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
           </ErrorBoundary>
          </div>
        )}

        {page === 'my-position' && (
          <div key="page-my-position" className="mx-auto w-full max-w-2xl space-y-3 animate-page-enter">
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
              <>
                {networkStats}
                {/* TODO: replace shared StatsBar above with a wallet-scoped summary (committed, invites remaining, hop level, mini subtree, activity feed). For now, we render the full StatsBar so connectedSummary is visible inline. */}
                <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground shadow-elevated">
                  <div className="mb-2 font-medium text-foreground">My Position</div>
                  Wallet-scoped dashboard coming soon — invite tools, activity feed, and a
                  focused view of your subtree will live here.
                </div>
              </>
            )}
          </div>
        )}
      </div>
     </ErrorBoundary>
    </AppShell>
  )
}
