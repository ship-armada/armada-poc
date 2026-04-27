// ABOUTME: Root component for the crowdfund observer app.
// ABOUTME: Read-only visualization of on-chain invite graph and commitment data.

import { useCallback, useState, useEffect, useMemo } from 'react'
import { type JsonRpcProvider } from 'ethers'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import {
  createProvider,
  useContractEvents,
  useGraphState,
  useSelection,
  useENS,
  useAllocations,
  StatsBar,
  TableView,
  SearchBar,
  TreeView,
  AppShell,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  ErrorAlert,
  ErrorBoundary,
  StaleDataBanner,
  formatUsdc,
  generateMockGraph,
  useContractState,
} from '@armada/crowdfund-shared'
import { getHubRpcUrls, getPollIntervalMs, getNetworkMode } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'

const COMMITTER_URL =
  (import.meta.env.VITE_COMMITTER_URL as string | undefined) ?? 'http://localhost:5174'

function ParticipateLink() {
  return (
    <Button asChild size="sm" variant="default">
      <a href={COMMITTER_URL} target="_blank" rel="noopener noreferrer">
        Participate
        <ArrowUpRight className="size-4" />
      </a>
    </Button>
  )
}

function ObserverMobileMenu() {
  return (
    <Button asChild variant="default" className="w-full justify-center">
      <a href={COMMITTER_URL} target="_blank" rel="noopener noreferrer">
        Participate
        <ArrowUpRight className="size-4" />
      </a>
    </Button>
  )
}

/**
 * Dev-only stress-test mode — renders TreeView + TableView against a
 * synthetic CrowdfundGraph bypassing all contract machinery. Enabled via
 * `?mock=stressN` (e.g. `?mock=stress500`). StatsBar is skipped because it
 * genuinely needs contract state (phase, sale size, window times); the tree
 * and table only need the graph's summaries/nodes and work fine.
 */
function MockObserverApp({ size }: { size: number }) {
  const graph = useMemo(() => generateMockGraph(size), [size])
  const summaryArray = useMemo(() => [...graph.summaries.values()], [graph])
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null)
  const [hoveredAddress, setHoveredAddress] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [focusRequest, setFocusRequest] = useState<{
    address: string
    tick: number
  } | null>(null)
  const resolveENS = useCallback(() => null, [])

  const handleViewInTable = useCallback((addr: string) => {
    setSelectedAddress(addr)
    setFocusRequest((prev) => ({ address: addr, tick: (prev?.tick ?? 0) + 1 }))
  }, [])

  return (
    <AppShell appName={`Observer · stress ?mock=stress${size}`} network="local">
      <div className="container mx-auto p-4 space-y-4">
        <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
          <strong>STRESS MODE</strong> — {graph.summaries.size} synthetic addresses rendered.
          Contract machinery bypassed. Remove <code>?mock=…</code> from the URL to exit.
        </div>
        <SearchBar value={searchQuery} onChange={setSearchQuery} />
        {/* items-start keeps each column at its own natural height. Without
            it the grid stretches both cells to match the tallest (usually
            TableView with 300 rows at stress300), pulling TreeView's
            container to a many-thousand-px height and producing a very
            tall, narrow ellipse plus a sim-restart feedback loop. */}
        <div className="grid lg:grid-cols-2 gap-4 items-start">
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
            />
          </ErrorBoundary>
        </div>
      </div>
    </AppShell>
  )
}

function getMockSizeFromUrl(): number {
  if (typeof window === 'undefined') return 0
  const p = new URLSearchParams(window.location.search).get('mock')
  if (!p) return 0
  const n = parseInt(p.replace(/^stress/, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function App() {
  const [mockSize] = useState(getMockSizeFromUrl)
  if (mockSize > 0) return <MockObserverApp size={mockSize} />

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  const [activeTab, setActiveTab] = useState<'tree' | 'table'>('tree')

  const pollInterval = getPollIntervalMs()

  // Load deployment manifest on mount
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

  const contractAddress = deployment?.contracts.crowdfund ?? null

  // Event fetching + graph construction
  const { events, loading: eventsLoading, error: eventsError } = useContractEvents({
    provider,
    contractAddress,
    pollIntervalMs: pollInterval,
    startBlock: deployment?.deployBlock,
  })

  const { graph, summaries, nodes } = useGraphState()

  // Aggregate contract state
  const contractState = useContractState(provider, contractAddress, pollInterval)

  // Selection state (includes hover)
  const {
    selectedAddress,
    selectAddress,
    searchQuery,
    setSearchQuery,
    hoveredAddress,
    setHoveredAddress,
    focusRequest,
    requestFocus,
  } = useSelection()

  // "View in table" selects the address AND scrolls the table. Plain tree clicks select only.
  const handleViewInTable = (addr: string) => {
    selectAddress(addr)
    requestFocus(addr)
  }

  // ENS resolution
  const addresses = useMemo(
    () => [...summaries.keys()],
    [summaries],
  )
  const { resolve: resolveENS } = useENS({ provider, addresses })

  // Prefetch allocations for unclaimed participants post-finalization
  const prefetchedAllocations = useAllocations({
    provider,
    contractAddress,
    phase: contractState.phase,
    refundMode: contractState.refundMode,
    summaries,
  })

  // Summaries as array for TableView, with prefetched allocations merged in
  const summaryArray = useMemo(() => {
    const arr = [...summaries.values()]
    if (prefetchedAllocations.size === 0) return arr

    // Merge prefetched allocations into summaries where event data is absent
    return arr.map((s) => {
      if (s.allocatedArm !== null) return s // Event data takes precedence
      const prefetched = prefetchedAllocations.get(s.address)
      if (!prefetched) return s
      return { ...s, allocatedArm: prefetched.armAmount, refundUsdc: prefetched.refundUsdc }
    })
  }, [summaries, prefetchedAllocations])

  // Loading state
  if (deployError) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center space-y-3">
          <h1 className="text-xl font-bold text-destructive">Deployment Not Found</h1>
          <p className="text-sm text-muted-foreground max-w-md">{deployError}</p>
          <p className="text-xs text-muted-foreground">
            Run <code className="bg-muted px-1 rounded">npm run setup</code> from the project root to deploy contracts.
          </p>
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

  // Pre-open state: ARM not loaded
  if (!contractState.armLoaded && contractState.phase === 0) {
    return (
      <AppShell
        appName="Observer"
        network={getNetworkMode()}
        headerRight={<ParticipateLink />}
        mobileMenu={<ObserverMobileMenu />}
      >
        <div className="container mx-auto p-4 space-y-4">
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <h2 className="text-lg font-medium mb-2">Crowdfund Not Yet Open</h2>
            <p className="text-sm text-muted-foreground">
              Waiting for ARM tokens to be loaded. The commitment window will start once ARM is loaded.
            </p>
            {contractState.seedCount > 0 && (
              <p className="text-sm text-muted-foreground mt-2">
                {contractState.seedCount} seed{contractState.seedCount !== 1 ? 's' : ''} added
              </p>
            )}
          </div>
        </div>
      </AppShell>
    )
  }

  // Empty state: ARM loaded but no seeds yet
  if (contractState.armLoaded && contractState.seedCount === 0 && contractState.phase === 0) {
    return (
      <AppShell
        appName="Observer"
        network={getNetworkMode()}
        headerRight={<ParticipateLink />}
        mobileMenu={<ObserverMobileMenu />}
      >
        <div className="container mx-auto p-4 space-y-4">
          <StatsBar
            hopStats={contractState.hopStats}
            totalCommitted={contractState.totalCommitted}
            cappedDemand={contractState.cappedDemand}
            saleSize={contractState.saleSize}
            participantCount={contractState.participantCount}
            phase={contractState.phase}
            armLoaded={contractState.armLoaded}
            windowEnd={contractState.windowEnd}
            blockTimestamp={contractState.blockTimestamp}
            isLoading={eventsLoading}
          />
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <TreeView
              graph={graph}
              selectedAddress={selectedAddress}
              onSelectAddress={selectAddress}
              searchQuery=""
              phase={contractState.phase}
              resolveENS={resolveENS}
              isLoading={eventsLoading}
            />
            <p className="text-sm text-muted-foreground mt-4">
              Waiting for seeds to be added...
            </p>
          </div>
        </div>
      </AppShell>
    )
  }

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

  const treeView = (
    <ErrorBoundary>
      <TreeView
        graph={graph}
        selectedAddress={selectedAddress}
        onSelectAddress={selectAddress}
        onViewInTable={handleViewInTable}
        onHoverAddress={setHoveredAddress}
        searchQuery={searchQuery}
        phase={contractState.phase}
        resolveENS={resolveENS}
        isLoading={eventsLoading}
        campaignHeader={treeCampaignHeader}
        campaignDetailsLink={treeCampaignDetailsLink}
      />
    </ErrorBoundary>
  )

  const tableView = (
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
        hoveredAddress={hoveredAddress}
        hopStats={contractState.hopStats}
        saleSize={contractState.saleSize}
        isLoading={eventsLoading}
      />
    </ErrorBoundary>
  )

  return (
    <AppShell
      appName="Observer"
      network={getNetworkMode()}
      headerRight={<ParticipateLink />}
      mobileMenu={<ObserverMobileMenu />}
    >
     <ErrorBoundary>
      <div className="container mx-auto p-4 space-y-4">
        <StaleDataBanner />
        {/* Error banner */}
        {(eventsError || contractState.error) && (
          <ErrorAlert>{eventsError || contractState.error}</ErrorAlert>
        )}

        {/* Cancellation banner */}
        {contractState.phase === 2 && (
          <ErrorAlert title="Crowdfund Cancelled">
            All participants can claim a full USDC refund.
          </ErrorAlert>
        )}

        {/* Refund mode banner */}
        {contractState.phase === 1 && contractState.refundMode && (
          <ErrorAlert variant="warning" title="Refund Mode">
            Total allocation after hop ceilings did not meet the minimum raise. All participants can claim a full USDC refund.
          </ErrorAlert>
        )}

        {/* Stats bar */}
        <ErrorBoundary>
          <StatsBar
            hopStats={contractState.hopStats}
            totalCommitted={contractState.totalCommitted}
            cappedDemand={contractState.cappedDemand}
            saleSize={contractState.saleSize}
            participantCount={contractState.participantCount}
            phase={contractState.phase}
            armLoaded={contractState.armLoaded}
            windowEnd={contractState.windowEnd}
            blockTimestamp={contractState.blockTimestamp}
            isLoading={eventsLoading}
          />
        </ErrorBoundary>

        {/* Search */}
        <SearchBar value={searchQuery} onChange={setSearchQuery} />

        {/* Mobile tab bar — visible below lg breakpoint */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as 'tree' | 'table')}
          className="lg:hidden"
        >
          <TabsList variant="line" className="w-full justify-start border-b border-border">
            <TabsTrigger value="tree" className="flex-1">
              Tree
            </TabsTrigger>
            <TabsTrigger value="table" className="flex-1">
              Table
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Desktop: side by side */}
        <div className="hidden lg:grid lg:grid-cols-2 gap-4 items-start">
          {treeView}
          {tableView}
        </div>

        {/* Mobile: active tab only */}
        <div className="lg:hidden">
          {activeTab === 'tree' ? treeView : tableView}
        </div>

        {/* Event count footer */}
        <div className="text-xs text-muted-foreground text-center">
          {events.length} events loaded
          {eventsLoading && ' (syncing...)'}
        </div>
      </div>
     </ErrorBoundary>
    </AppShell>
  )
}
