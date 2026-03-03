// ABOUTME: Root application component for the crowdfund testing frontend.
// ABOUTME: Single-page layout with all crowdfund panels visible.
import { Header } from '@/components/Header'
import { SaleStatus } from '@/components/SaleStatus'
import { AdminPanel } from '@/components/AdminPanel'
import { ParticipantPanel } from '@/components/ParticipantPanel'
import { TimeControls } from '@/components/TimeControls'
import { ParticipantsTable } from '@/components/ParticipantsTable'
import { EventLog } from '@/components/EventLog'
import { useAccounts } from '@/hooks/useAccounts'
import { useCrowdfund } from '@/hooks/useCrowdfund'
import { isLocalMode } from '@/config/network'

export function App() {
  const accounts = useAccounts()
  const crowdfund = useCrowdfund(accounts.provider, accounts.getActiveSigner)
  const { state, events } = crowdfund

  // Error state: deployment not found
  if (state.error && !state.lastUpdated) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-2xl font-bold">Armada Crowdfund Tester</h1>
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{state.error}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Make sure Anvil is running (<code className="text-xs bg-muted px-1 py-0.5 rounded">npm run chains</code>)
            and contracts are deployed (<code className="text-xs bg-muted px-1 py-0.5 rounded">npm run setup</code>).
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header accounts={accounts} crowdfund={crowdfund} />
      <main className="max-w-6xl mx-auto p-6 space-y-6">
        <SaleStatus state={state} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {accounts.isAdmin && (
            <AdminPanel state={state} crowdfund={crowdfund} />
          )}
          <ParticipantPanel state={state} crowdfund={crowdfund} />
        </div>
        {isLocalMode() && accounts.isAdmin && <TimeControls state={state} crowdfund={crowdfund} />}
        <ParticipantsTable state={state} crowdfund={crowdfund} />
        <EventLog events={events} />
      </main>
    </div>
  )
}
