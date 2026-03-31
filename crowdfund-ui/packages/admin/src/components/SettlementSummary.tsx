// ABOUTME: Post-finalization settlement stats with claim tracking and refund breakdown.
// ABOUTME: Shows finalizedAt, sale size, refund mode, ARM claims, net proceeds, and refunds.

import {
  formatUsdc,
  formatArm,
  formatCountdown,
  type CrowdfundEvent,
} from '@armada/crowdfund-shared'
import type { AdminState } from '@/hooks/useAdminState'

export interface SettlementSummaryProps {
  state: AdminState
  events: CrowdfundEvent[]
}

export function SettlementSummary({ state, events }: SettlementSummaryProps) {
  const claimTimeLeft = state.claimDeadline - state.blockTimestamp

  // Extract net proceeds from Finalized event
  const finalizedEvent = events.find((e) => e.type === 'Finalized')
  const netProceeds = finalizedEvent?.args.netProceeds as bigint | undefined

  // Compute ARM claim stats
  const armClaimedPct = state.totalAllocatedArm > 0n
    ? Number(state.totalArmTransferred * 10000n / state.totalAllocatedArm) / 100
    : 0
  const armUnclaimed = state.totalAllocatedArm - state.totalArmTransferred

  // Sum refunds from events
  const refundsOwed = netProceeds !== undefined
    ? (state.totalCommitted > netProceeds ? state.totalCommitted - netProceeds : 0n)
    : 0n

  const refundsClaimed = events
    .filter((e) => e.type === 'RefundClaimed')
    .reduce((sum, e) => sum + (e.args.usdcAmount as bigint), 0n)

  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="text-sm font-medium">Settlement Summary</div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted-foreground">Finalized at: </span>
          <span className="font-medium">{new Date(state.finalizedAt * 1000).toLocaleString()}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Sale size: </span>
          <span className="font-medium">{formatUsdc(state.saleSize)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Refund mode: </span>
          <span className={`font-medium ${state.refundMode ? 'text-destructive' : 'text-success'}`}>
            {state.refundMode ? 'Yes' : 'No'}
          </span>
        </div>
        {netProceeds !== undefined && (
          <div>
            <span className="text-muted-foreground">Net proceeds: </span>
            <span className="font-medium">{formatUsdc(netProceeds)}</span>
          </div>
        )}
        <div>
          <span className="text-muted-foreground">ARM claimed: </span>
          <span className="font-medium">
            {formatArm(state.totalArmTransferred)} ({armClaimedPct.toFixed(1)}%)
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">ARM unclaimed: </span>
          <span className="font-medium">{formatArm(armUnclaimed)}</span>
        </div>
        {refundsOwed > 0n && (
          <>
            <div>
              <span className="text-muted-foreground">Refunds owed: </span>
              <span className="font-medium">{formatUsdc(refundsOwed)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Refunds claimed: </span>
              <span className="font-medium">{formatUsdc(refundsClaimed)}</span>
            </div>
          </>
        )}
        <div>
          <span className="text-muted-foreground">Claim deadline: </span>
          <span className="font-medium">{claimTimeLeft > 0 ? formatCountdown(claimTimeLeft) : 'expired'}</span>
        </div>
        {/* TODO: governance quiet period — value not available from contract */}
      </div>
    </div>
  )
}
