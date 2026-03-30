// ABOUTME: Root component for the crowdfund admin app.
// ABOUTME: Launch team and security council operations dashboard.

import { useState, useEffect, useCallback } from 'react'
import { JsonRpcProvider } from 'ethers'
import { getHubRpcUrl, getPollIntervalMs, getNetworkMode, isLocalMode } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import { useWallet } from '@/hooks/useWallet'
import { useRole } from '@/hooks/useRole'
import { useAdminState } from '@/hooks/useAdminState'
import { useAdminEvents } from '@/hooks/useAdminEvents'
import { useTreasuryBalances } from '@/hooks/useTreasuryBalances'
import { useTimeControls } from '@/hooks/useTimeControls'
import { useParticipants } from '@/hooks/useParticipants'
import { WalletHeader } from '@/components/WalletHeader'
import { StatusDashboard } from '@/components/StatusDashboard'
import { AdminActions } from '@/components/AdminActions'
import { EventLog } from '@/components/EventLog'
import { ParticipantTable } from '@/components/ParticipantTable'
import { TimeControls } from '@/components/TimeControls'

export function App() {
  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)

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
  const armTokenAddress = deployment?.contracts.armToken ?? null

  // Core hooks
  const wallet = useWallet()
  const { role, treasuryAddress, loading: roleLoading } = useRole(provider, crowdfundAddress, wallet.address)
  const adminState = useAdminState(provider, crowdfundAddress, pollInterval)
  const { events, loading: eventsLoading } = useAdminEvents(provider, crowdfundAddress)
  const treasury = useTreasuryBalances(provider, crowdfundAddress, treasuryAddress, usdcAddress, armTokenAddress)
  const timeControls = useTimeControls(provider)
  const participants = useParticipants(events)

  // USDC mint handler (local only)
  const handleMintUsdc = useCallback(async (recipient: string, amount: string) => {
    try {
      const response = await fetch('/api/mint-usdc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient,
          amount: String(BigInt(Math.floor(parseFloat(amount))) * 10n ** 6n),
          usdcAddress,
        }),
      })
      if (!response.ok) throw new Error('Mint failed')
    } catch {
      // Non-fatal
    }
  }, [usdcAddress])

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

  if (!deployment || adminState.loading || roleLoading) {
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
        <WalletHeader
          address={wallet.address}
          role={role}
          connected={wallet.connected}
          connecting={wallet.connecting}
          error={wallet.error}
          onConnect={wallet.connect}
          onDisconnect={wallet.disconnect}
        />

        {/* Status Dashboard */}
        <StatusDashboard state={adminState} role={role} />

        {/* Admin Actions + Event Log (side by side) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <AdminActions
            state={adminState}
            role={role}
            signer={wallet.signer}
            crowdfundAddress={crowdfundAddress!}
            treasury={treasury}
          />
          <EventLog events={events} loading={eventsLoading} />
        </div>

        {/* Participant Table */}
        <ParticipantTable participants={participants} phase={adminState.phase} />

        {/* Local Dev Controls */}
        {isLocalMode() && (
          <TimeControls
            timeControls={timeControls}
            state={adminState}
            onMintUsdc={handleMintUsdc}
          />
        )}
      </div>
    </div>
  )
}
