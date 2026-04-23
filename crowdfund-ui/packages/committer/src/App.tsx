// ABOUTME: Root component for the crowdfund committer app.
// ABOUTME: Embeds observer as left panel, adds wallet-connected action panel on right.

import { useState, useEffect, useMemo } from 'react'
import { type JsonRpcProvider } from 'ethers'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Wallet } from 'lucide-react'
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
  useContractState,
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
        <span className="text-xs text-muted-foreground">
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
      {wallet.connected ? (
        <div className="flex flex-col gap-1 text-sm">
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

  return (
    <AppShell
      appName="Committer"
      network={getNetworkMode()}
      headerRight={walletChrome}
      mobileMenu={mobileMenu}
    >
     <ErrorBoundary>
      <div className="container mx-auto p-4 space-y-4">
        <StaleDataBanner />
        {/* Wallet error */}
        {wallet.error && <ErrorAlert>{wallet.error}</ErrorAlert>}

        {/* Stats bar with connected user summary */}
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

        {/* Mobile tab bar — visible below lg breakpoint */}
        <Tabs
          value={mobileTab}
          onValueChange={(v) => setMobileTab(v as MobileTab)}
          className="lg:hidden"
        >
          <TabsList variant="line" className="w-full justify-start border-b border-border">
            <TabsTrigger value="network" className="flex-1 capitalize">
              network
            </TabsTrigger>
            <TabsTrigger value="participate" className="flex-1 capitalize">
              participate
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Two-panel layout */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Observer panel (left ~60%) — hidden on mobile when participate tab active */}
          <div className={`lg:col-span-3 space-y-3 ${mobileTab === 'participate' ? 'hidden lg:block' : ''}`}>
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
              />
            </ErrorBoundary>
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

          {/* Action panel (right ~40%) — hidden on mobile when network tab active */}
          <div className={`lg:col-span-2 ${mobileTab === 'network' ? 'hidden lg:block' : ''}`}>
           <ErrorBoundary>
            {!wallet.connected ? (
              <div className="rounded-lg border border-border bg-card">
                <EmptyState
                  icon={Wallet}
                  title="Connect your wallet to participate"
                  description="Commit USDC, issue invites, and claim ARM once the crowdfund finalizes."
                  action={<ConnectButton />}
                />
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card">
                {/* Tab header — always visible, disabled tabs show message */}
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
           </ErrorBoundary>
          </div>
        </div>
      </div>
     </ErrorBoundary>
    </AppShell>
  )
}
