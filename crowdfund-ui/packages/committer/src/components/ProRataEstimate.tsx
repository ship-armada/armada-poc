// ABOUTME: Displays estimated pro-rata allocation based on current demand.
// ABOUTME: Shows per-hop breakdown with oversubscription warnings.

import {
  InfoTooltip,
  TOOLTIPS,
  formatUsdc,
  formatArm,
  hopLabel,
} from '@armada/crowdfund-shared'
import type { HopEstimate } from '@/hooks/useProRataEstimate'

export interface ProRataEstimateProps {
  hopEstimates: HopEstimate[]
  totalEstimatedArm: bigint
  totalEstimatedRefund: bigint
}

export function ProRataEstimate(props: ProRataEstimateProps) {
  const { hopEstimates, totalEstimatedArm, totalEstimatedRefund } = props

  if (hopEstimates.length === 0) return null

  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <span>Estimated Allocation</span>
        <InfoTooltip text={TOOLTIPS.allocation} label="What is allocation?" />
        <InfoTooltip text={TOOLTIPS.proRata} label="What is pro-rata?" />
      </div>

      {hopEstimates.map((est) => (
        <div key={est.hop} className="text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span>{hopLabel(est.hop)}</span>
            <span>
              {formatUsdc(est.estimatedAccepted)} of {formatUsdc(est.totalPosition)}
              {est.existingCommitted > 0n && (
                <span className="text-muted-foreground ml-1">
                  (adding {formatUsdc(est.commitAmount)} to {formatUsdc(est.existingCommitted)})
                </span>
              )}
            </span>
          </div>
          {est.oversubscriptionPct > 100 && (
            <div className="text-amber-500">
              {est.oversubscriptionPct}% of ceiling — oversubscribed, pro-rata applies
            </div>
          )}
        </div>
      ))}

      <div className="border-t border-border pt-2 space-y-1">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Est. ARM</span>
          <span className="font-medium text-success">{formatArm(totalEstimatedArm)}</span>
        </div>
        {totalEstimatedRefund > 0n && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Est. USDC refund</span>
            <span>{formatUsdc(totalEstimatedRefund)}</span>
          </div>
        )}
      </div>

      <div className="text-[10px] text-muted-foreground space-y-0.5">
        <div>Estimate only — demand changes between now and deadline.</div>
        <div>Commitments are final — no withdrawals before deadline.</div>
        <div>3-week maximum lock — USDC locked until finalization + refund claim.</div>
      </div>
    </div>
  )
}
