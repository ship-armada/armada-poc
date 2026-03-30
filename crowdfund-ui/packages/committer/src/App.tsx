// ABOUTME: Root component for the crowdfund committer app.
// ABOUTME: Embeds observer as left panel, adds wallet-connected action panel on right.

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
} from '@armada/crowdfund-shared'
import { getHubRpcUrl, getPollIntervalMs, getNetworkMode } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import { useWallet } from '@/hooks/useWallet'
import { useEligibility } from '@/hooks/useEligibility'
import { useAllowance } from '@/hooks/useAllowance'
import { useContractState } from '@/hooks/useContractState'
import { CommitTab } from '@/components/CommitTab'
import { InviteTab } from '@/components/InviteTab'

type ActionTab = 'commit' | 'invite'

export function App() {
  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  const [activeTab, setActiveTab] = useState<ActionTab>('commit')

  const pollInterval = getPollIntervalMs()

  // Load deployment
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

  const crowdfundAddress = deployment?.contracts.crowdfund ?? null
  const usdcAddress = deployment?.contracts.usdc ?? null

  // Shared data layer
  const { events, loading: eventsLoading } = useContractEvents({
    provider,
    contractAddress: crowdfundAddress,
    pollIntervalMs: pollInterval,
  })
  const { summaries, nodes } = useGraphState()
  const contractState = useContractState(provider, crowdfundAddress, pollInterval)
  const { selectedAddress, selectAddress, searchQuery, setSearchQuery } = useSelection()

  // ENS
  const addresses = useMemo(() => [...summaries.keys()], [summaries])
  const { resolve: resolveENS } = useENS({ provider, addresses })
  const summaryArray = useMemo(() => [...summaries.values()], [summaries])

  // Wallet
  const wallet = useWallet()

  // Wallet-specific hooks
  const eligibility = useEligibility(wallet.address, nodes)
  const allowance = useAllowance(wallet.address, usdcAddress, crowdfundAddress, provider)

  // Is the commitment window open?
  const windowOpen =
    contractState.armLoaded &&
    contractState.blockTimestamp >= contractState.windowStart &&
    contractState.blockTimestamp <= contractState.windowEnd

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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Armada Crowdfund</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {getNetworkMode().toUpperCase()}
            </span>
            {wallet.connected ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-muted-foreground">
                  {wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}
                </span>
                <button
                  className="text-xs text-destructive hover:underline"
                  onClick={wallet.disconnect}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                onClick={wallet.connect}
                disabled={wallet.connecting}
              >
                {wallet.connecting ? 'Connecting...' : 'Connect Wallet'}
              </button>
            )}
          </div>
        </div>

        {/* Wallet error */}
        {wallet.error && (
          <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {wallet.error}
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

        {/* Two-panel layout */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Observer panel (left ~60%) */}
          <div className="lg:col-span-3 space-y-3">
            <SearchBar value={searchQuery} onChange={setSearchQuery} />
            <TableView
              summaries={summaryArray}
              nodes={nodes}
              selectedAddress={selectedAddress ?? wallet.address}
              onSelectAddress={selectAddress}
              searchQuery={searchQuery}
              phase={contractState.phase}
              resolveENS={resolveENS}
            />
            <div className="text-xs text-muted-foreground text-center">
              {events.length} events loaded {eventsLoading && '(syncing...)'}
            </div>
          </div>

          {/* Action panel (right ~40%) */}
          <div className="lg:col-span-2">
            {!wallet.connected ? (
              <div className="rounded-lg border border-border bg-card p-6 text-center space-y-3">
                <div className="text-muted-foreground">Connect your wallet to participate</div>
                <button
                  className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  onClick={wallet.connect}
                  disabled={wallet.connecting}
                >
                  {wallet.connecting ? 'Connecting...' : 'Connect Wallet'}
                </button>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card">
                {/* Tab header */}
                <div className="flex border-b border-border">
                  {(['commit', 'invite'] as const).map((tab) => (
                    <button
                      key={tab}
                      className={`flex-1 px-4 py-2 text-sm font-medium capitalize ${
                        activeTab === tab
                          ? 'border-b-2 border-primary text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={() => setActiveTab(tab)}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className="p-4">
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
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
