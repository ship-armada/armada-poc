// ABOUTME: Dev-only ?mock=stressN harness — synthetic CrowdfundGraph against the observer panels.
// ABOUTME: Lazy-loaded so its heavy deps (TreeView/TableView → d3 + react-table) stay out of the main chunk.

import { useCallback, useMemo, useState } from 'react'
import { ArrowRight, Wallet } from 'lucide-react'
import {
  Button,
  TableView,
  SearchBar,
  TreeView,
  AppShell,
  Tabs,
  TabsList,
  TabsTrigger,
  ErrorBoundary,
  WhatsNextCard,
  generateMockGraph,
} from '@armada/crowdfund-shared'
import { PageNav, type ActionTab, type Page } from '@/appNav'

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
export default function MockCommitterApp({ size }: { size: number }) {
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
        <div className="rounded-lg border border-border bg-card p-3 text-muted-foreground">
          <strong>STRESS MODE</strong> — {graph.summaries.size} synthetic addresses rendered,
          action-panel visuals stubbed as a whitelisted hop-1 participant.
          Interactions are disabled. Remove <code>?mock=…</code> from the URL to exit.
        </div>

        {page === 'network' && (
          <div key="mock-page-network" className="space-y-8 animate-page-enter">
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
                    <div className="">
                      Armada Crowdfund
                    </div>
                    <div className="mt-2 flex items-start gap-4">
                      <div>
                        <div className="text-foreground">
                          $15,000
                        </div>
                        <div className="text-muted-foreground">
                          Committed
                        </div>
                      </div>
                      <div className="h-8 w-px bg-border/60" aria-hidden="true" />
                      <div>
                        <div className="text-foreground">
                          {graph.summaries.size}
                        </div>
                        <div className="text-muted-foreground">
                          Participants
                        </div>
                      </div>
                      <div className="h-8 w-px bg-border/60" aria-hidden="true" />
                      <div>
                        <div className="text-foreground">13</div>
                        <div className="text-muted-foreground">
                          Days left
                        </div>
                      </div>
                    </div>
                  </div>
                }
                campaignDetailsLink={
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/80 px-3 py-1.5 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground"
                  >
                    View campaign details
                    <ArrowRight className="size-3" />
                  </button>
                }
                participateCta={
                  <div className="flex flex-col items-stretch gap-6 px-5 py-4 text-center sm:flex-row sm:items-center sm:justify-center sm:gap-0 sm:text-left">
                    <div className="space-y-1.5">
                      <div className="text-foreground">
                        Ready to join this network?
                      </div>
                      <div className="text-muted-foreground">
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
            <div className="rounded-lg border border-border bg-card p-6 shadow-elevated">
              <div className="mb-1 text-foreground">Claim isn't open yet</div>
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
            className="mx-auto max-w-2xl rounded-lg border border-border bg-card p-6 text-muted-foreground shadow-elevated animate-page-enter"
          >
            <div className="mb-2 text-foreground">My position</div>
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
  const truncated = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—'
  return (
    <div className="rounded-lg border border-border bg-card shadow-elevated">
      {/* Header — fake wallet identity so the panel reads as "connected". */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <div className="size-6 rounded-full bg-muted flex items-center justify-center">
          <Wallet className="size-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <div className="text-muted-foreground">Mock wallet · Hop 1</div>
          <div className="">{truncated}</div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as ActionTab)}>
        <TabsList variant="line" className="w-full justify-start border-b border-border">
          {(['commit', 'invite'] as const).map((tab) => (
            <TabsTrigger key={tab} value={tab} className="flex-1">
              {tab}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="p-6 space-y-3">
        {activeTab === 'commit' && (
          <>
            <div className="text-foreground">Commit USDC</div>
            <div className="text-muted-foreground">
              Eligible at Hop 1. In a live session you'd enter a per-hop
              USDC amount, review the pro-rata estimate, approve USDC, and
              submit a commit transaction here.
            </div>
          </>
        )}
        {activeTab === 'invite' && (
          <>
            <div className="text-foreground">Invite participants</div>
            <div className="text-muted-foreground">
              Generate an EIP-712 signed invite link or issue a direct
              on-chain invite to a specific address. Slot counts and
              expiration are shown here in live mode.
            </div>
          </>
        )}
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-muted-foreground">
          Interactions disabled — no signer or contract state in stress mode.
        </div>
      </div>
    </div>
  )
}
