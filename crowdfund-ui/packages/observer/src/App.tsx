// ABOUTME: Root component for the crowdfund observer app.
// ABOUTME: Read-only visualization of on-chain invite graph and commitment data.

import { useState, useEffect, useMemo } from 'react'
import { type JsonRpcProvider } from 'ethers'
import { ArrowUpRight } from 'lucide-react'
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
} from '@armada/crowdfund-shared'
import { getHubRpcUrls, getPollIntervalMs, getNetworkMode } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import { useContractState } from '@/hooks/useContractState'

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

export function App() {
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
  } = useSelection()

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
            phase={contractState.phase}
            armLoaded={contractState.armLoaded}
            seedCount={contractState.seedCount}
            participantCount={contractState.participantCount}
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

  const treeView = (
    <ErrorBoundary>
      <TreeView
        graph={graph}
        selectedAddress={selectedAddress}
        onSelectAddress={selectAddress}
        onHoverAddress={setHoveredAddress}
        searchQuery={searchQuery}
        phase={contractState.phase}
        resolveENS={resolveENS}
        isLoading={eventsLoading}
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
            phase={contractState.phase}
            armLoaded={contractState.armLoaded}
            seedCount={contractState.seedCount}
            participantCount={contractState.participantCount}
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
        <div className="hidden lg:grid lg:grid-cols-2 gap-4">
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
