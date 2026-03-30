// ABOUTME: Treasury balance display for USDC and ARM tokens.
// ABOUTME: Shows balances at both the contract and treasury addresses.

import { formatUsdc, formatArm } from '@armada/crowdfund-shared'
import type { TreasuryBalances } from '@/hooks/useTreasuryBalances'

export interface TreasuryMonitorProps {
  treasury: TreasuryBalances
}

export function TreasuryMonitor({ treasury }: TreasuryMonitorProps) {
  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="text-sm font-medium">Treasury Monitor</div>
      {treasury.loading ? (
        <div className="text-xs text-muted-foreground">Loading balances...</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="space-y-1">
            <div className="text-muted-foreground font-medium">Contract</div>
            <div>USDC: {formatUsdc(treasury.contractUsdcBalance)}</div>
            <div>ARM: {formatArm(treasury.contractArmBalance)}</div>
          </div>
          <div className="space-y-1">
            <div className="text-muted-foreground font-medium">Treasury</div>
            <div>USDC: {formatUsdc(treasury.treasuryUsdcBalance)}</div>
            <div>ARM: {formatArm(treasury.treasuryArmBalance)}</div>
          </div>
        </div>
      )}
    </div>
  )
}
