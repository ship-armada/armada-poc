// ABOUTME: Root component for the crowdfund committer app.
// ABOUTME: Embeds observer as left panel, adds wallet-connected action panel on right.

import { useState, useEffect, useMemo } from 'react'
import { type JsonRpcProvider } from 'ethers'
import {
  createProvider,
  useContractEvents,
  useGraphState,
  useSelection,
  useENS,
  StatsBar,
  TableView,
  SearchBar,
  TreeView,
  CROWDFUND_CONSTANTS,
  formatUsdc,
  type ConnectedSummary,
} from '@armada/crowdfund-shared'
import { getHubRpcUrls, getPollIntervalMs, getNetworkMode } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import { useWallet } from '@/hooks/useWallet'
import { useEligibility } from '@/hooks/useEligibility'
import { useAllowance } from '@/hooks/useAllowance'
import { useContractState } from '@/hooks/useContractState'
import { useInviteLinks } from '@/hooks/useInviteLinks'
import { CommitTab } from '@/components/CommitTab'
import { InviteTab } from '@/components/InviteTab'
import { ClaimTab } from '@/components/ClaimTab'

type ActionTab = 'commit' | 'invite' | 'claim'
type MobileTab = 'network' | 'participate'

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
  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)
  const [activeTab, setActiveTab] = useState<ActionTab>('commit')
  const [mobileTab, setMobileTab] = useState<MobileTab>('participate')

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

  // Shared data layer
  const { events, loading: eventsLoading } = useContractEvents({
    provider,
    contractAddress: crowdfundAddress,
    pollIntervalMs: pollInterval,
  })
  const { graph, summaries, nodes } = useGraphState()
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

  // Wallet header ENS name
  const walletENS = wallet.address ? resolveENS(wallet.address) : null

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
        {/* Header with ENS name and balance */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Armada Crowdfund</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {getNetworkMode().toUpperCase()}
            </span>
            {wallet.connected ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {formatUsdc(allowance.balance)}
                </span>
                <span className="text-xs font-mono text-foreground">
                  {walletENS ?? `${wallet.address?.slice(0, 6)}...${wallet.address?.slice(-4)}`}
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

        {/* Stats bar with connected user summary */}
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
        />

        {/* Mobile tab bar — visible below lg breakpoint */}
        <div className="flex lg:hidden border-b border-border">
          {(['network', 'participate'] as const).map((tab) => (
            <button
              key={tab}
              className={`flex-1 px-4 py-2 text-sm font-medium capitalize ${
                mobileTab === tab
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setMobileTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Two-panel layout */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Observer panel (left ~60%) — hidden on mobile when participate tab active */}
          <div className={`lg:col-span-3 space-y-3 ${mobileTab === 'participate' ? 'hidden lg:block' : ''}`}>
            <SearchBar value={searchQuery} onChange={setSearchQuery} />
            <TreeView
              graph={graph}
              selectedAddress={selectedAddress ?? wallet.address}
              onSelectAddress={selectAddress}
              searchQuery={searchQuery}
              phase={contractState.phase}
              resolveENS={resolveENS}
              connectedAddress={wallet.address}
            />
            <TableView
              summaries={summaryArray}
              nodes={nodes}
              selectedAddress={selectedAddress ?? wallet.address}
              onSelectAddress={selectAddress}
              searchQuery={searchQuery}
              phase={contractState.phase}
              resolveENS={resolveENS}
              hopStats={contractState.hopStats}
              saleSize={contractState.saleSize}
              connectedAddress={wallet.address}
            />
            <div className="text-xs text-muted-foreground text-center">
              {events.length} events loaded {eventsLoading && '(syncing...)'}
            </div>
          </div>

          {/* Action panel (right ~40%) — hidden on mobile when network tab active */}
          <div className={`lg:col-span-2 ${mobileTab === 'network' ? 'hidden lg:block' : ''}`}>
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
                {/* Tab header — always visible, disabled tabs show message */}
                <div className="flex border-b border-border">
                  {(['commit', 'invite', 'claim'] as const).map((tab) => {
                    const state = tabStates[tab]
                    return (
                      <button
                        key={tab}
                        className={`flex-1 px-4 py-2 text-sm font-medium capitalize ${
                          activeTab === tab
                            ? 'border-b-2 border-primary text-foreground'
                            : state.enabled
                              ? 'text-muted-foreground hover:text-foreground'
                              : 'text-muted-foreground/50 cursor-not-allowed'
                        }`}
                        onClick={() => state.enabled && setActiveTab(tab)}
                      >
                        {tab}
                      </button>
                    )
                  })}
                </div>

                {/* Tab content */}
                <div className="p-4">
                  {/* Show disabled message for inactive tabs */}
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
          </div>
        </div>
      </div>
    </div>
  )
}
