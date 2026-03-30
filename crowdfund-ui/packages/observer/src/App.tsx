// ABOUTME: Root component for the crowdfund observer app.
// ABOUTME: Read-only visualization of on-chain invite graph and commitment data.

import { useState, useEffect, useMemo } from 'react'
import { JsonRpcProvider } from 'ethers'
import {
  useContractEvents,
  useGraphState,
  useSelection,
  useENS,
  StatsBar,
  TableView,
  SearchBar,
  TreeView,
} from '@armada/crowdfund-shared'
import { getHubRpcUrl, getPollIntervalMs, getNetworkMode } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import { useContractState } from '@/hooks/useContractState'

export function App() {
  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)

  const pollInterval = getPollIntervalMs()

  // Load deployment manifest on mount
  useEffect(() => {
    loadDeployment()
      .then((d) => {
        setDeployment(d)
        setProvider(new JsonRpcProvider(getHubRpcUrl()))
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
  })

  const { graph, summaries, nodes } = useGraphState()

  // Aggregate contract state
  const contractState = useContractState(provider, contractAddress, pollInterval)

  // Selection state
  const { selectedAddress, selectAddress, searchQuery, setSearchQuery } = useSelection()

  // ENS resolution
  const addresses = useMemo(
    () => [...summaries.keys()],
    [summaries],
  )
  const { resolve: resolveENS } = useENS({ provider, addresses })

  // Summaries as array for TableView
  const summaryArray = useMemo(
    () => [...summaries.values()],
    [summaries],
  )

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
      <div className="min-h-screen bg-background text-foreground">
        <div className="container mx-auto p-4 space-y-4">
          <Header />
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
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto p-4 space-y-4">
        <Header />

        {/* Error banner */}
        {(eventsError || contractState.error) && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {eventsError || contractState.error}
          </div>
        )}

        {/* Cancellation banner */}
        {contractState.phase === 2 && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-center">
            <h2 className="text-lg font-medium text-destructive mb-1">Crowdfund Cancelled</h2>
            <p className="text-sm text-muted-foreground">
              All participants can claim a full USDC refund.
            </p>
          </div>
        )}

        {/* Refund mode banner */}
        {contractState.phase === 1 && contractState.refundMode && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-center">
            <h2 className="text-lg font-medium text-amber-500 mb-1">Refund Mode</h2>
            <p className="text-sm text-muted-foreground">
              Capped demand did not meet the minimum sale size. All participants can claim a full USDC refund.
            </p>
          </div>
        )}

        {/* Stats bar */}
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
        />

        {/* Search */}
        <SearchBar value={searchQuery} onChange={setSearchQuery} />

        {/* Main content: tree + table */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TreeView
            graph={graph}
            selectedAddress={selectedAddress}
            onSelectAddress={selectAddress}
            searchQuery={searchQuery}
            phase={contractState.phase}
            resolveENS={resolveENS}
          />
          <TableView
            summaries={summaryArray}
            nodes={nodes}
            selectedAddress={selectedAddress}
            onSelectAddress={selectAddress}
            searchQuery={searchQuery}
            phase={contractState.phase}
            resolveENS={resolveENS}
          />
        </div>

        {/* Event count footer */}
        <div className="text-xs text-muted-foreground text-center">
          {events.length} events loaded
          {eventsLoading && ' (syncing...)'}
        </div>
      </div>
    </div>
  )
}

function Header() {
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-2xl font-bold tracking-tight">
        Armada Crowdfund Observer
      </h1>
      <span className="text-xs text-muted-foreground">
        {getNetworkMode().toUpperCase()}
      </span>
    </div>
  )
}
