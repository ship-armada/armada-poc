// ABOUTME: Header bar showing connected wallet address, role badge, and network.
// ABOUTME: Role badges: green for launch team, red for security council, grey for observer.

import type { AdminRole } from '@/hooks/useRole'
import { truncateAddress } from '@armada/crowdfund-shared'
import { getNetworkMode } from '@/config/network'

export interface WalletHeaderProps {
  address: string | null
  role: AdminRole
  connected: boolean
  connecting: boolean
  error: string | null
  onConnect: () => void
  onDisconnect: () => void
}

function roleBadge(role: AdminRole): { label: string; className: string } {
  switch (role) {
    case 'launch_team':
      return { label: 'Launch Team', className: 'bg-success/20 text-success' }
    case 'security_council':
      return { label: 'Security Council', className: 'bg-destructive/20 text-destructive' }
    case 'observer':
      return { label: 'Observer', className: 'bg-muted text-muted-foreground' }
  }
}

export function WalletHeader(props: WalletHeaderProps) {
  const { address, role, connected, connecting, error, onConnect, onDisconnect } = props
  const badge = roleBadge(role)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Armada Crowdfund Admin</h1>
          <span className="text-xs text-muted-foreground uppercase">
            {getNetworkMode()}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {connected && address ? (
            <>
              <span className={`text-xs px-2 py-1 rounded ${badge.className}`}>
                {badge.label}
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                {truncateAddress(address)}
              </span>
              <button
                className="text-xs text-destructive hover:underline"
                onClick={onDisconnect}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              onClick={onConnect}
              disabled={connecting}
            >
              {connecting ? 'Connecting...' : 'Connect Wallet'}
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  )
}
