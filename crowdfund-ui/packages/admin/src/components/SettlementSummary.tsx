// ABOUTME: Post-finalization settlement stats display.
// ABOUTME: Shows finalizedAt, sale size, refund mode, claims count, and claim deadline.

import {
  formatUsdc,
  formatArm,
  formatCountdown,
} from '@armada/crowdfund-shared'
import type { AdminState } from '@/hooks/useAdminState'

export interface SettlementSummaryProps {
  state: AdminState
}

export function SettlementSummary({ state }: SettlementSummaryProps) {
  const claimTimeLeft = state.claimDeadline - state.blockTimestamp

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
        <div>
          <span className="text-muted-foreground">Total allocated ARM: </span>
          <span className="font-medium">{formatArm(state.totalAllocatedArm)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">ARM transferred: </span>
          <span className="font-medium">{formatArm(state.totalArmTransferred)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Claim deadline: </span>
          <span className="font-medium">{claimTimeLeft > 0 ? formatCountdown(claimTimeLeft) : 'expired'}</span>
        </div>
      </div>
    </div>
  )
}
