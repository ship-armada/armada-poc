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
    <div className="space-y-2 rounded-lg border border-primary/25 bg-primary/5 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <span>Estimated Allocation</span>
        <InfoTooltip text={TOOLTIPS.allocation} label="What is allocation?" />
        <InfoTooltip text={TOOLTIPS.proRata} label="What is pro-rata?" />
      </div>

      {hopEstimates.map((est) => (
        <div key={est.hop} className="space-y-1 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{hopLabel(est.hop)}</span>
            <span className="font-medium tabular-nums text-foreground">
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

      <div className="space-y-1 border-t border-primary/20 pt-2">
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

      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>Estimate only — demand changes between now and deadline.</div>
        <div>Commitments are final — no withdrawals before deadline.</div>
        <div>3-week maximum lock — USDC locked until finalization + refund claim.</div>
      </div>
    </div>
  )
}
