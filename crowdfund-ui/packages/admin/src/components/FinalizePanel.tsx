// ABOUTME: Pre-finalization summary with outcome preview and finalize button.
// ABOUTME: Shows capped demand, projected allocation, expected outcome (incl. the launch-team payment), and refunds.

import { Contract } from 'ethers'
import type { Signer } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  estimateAllocation,
  projectedLaunchTeamPayment,
  projectsRefundMode,
  formatUsdc,
  formatArm,
  HOP_CONFIGS,
} from '@armada/crowdfund-shared'
import type { HopAllocationStats } from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface FinalizePanelProps {
  signer: Signer | null
  crowdfundAddress: string
  totalCommitted: bigint
  saleSize: bigint
  cappedDemand: bigint
  /** Per-hop capped demand, for projecting the post-waterfall allocation. */
  hopStats: readonly HopAllocationStats[]
}

export function FinalizePanel({ signer, crowdfundAddress, totalCommitted, cappedDemand, hopStats }: FinalizePanelProps) {
  const tx = useTransactionFlow(signer)
  const { MIN_SALE, ELASTIC_TRIGGER, BASE_SALE, MAX_SALE } = CROWDFUND_CONSTANTS
  const config = { constants: CROWDFUND_CONSTANTS, hopConfigs: HOP_CONFIGS }
  // The elastic trigger only changes the sale size when MAX_SALE exceeds BASE_SALE.
  const canExpand = MAX_SALE !== BASE_SALE

  // finalize() refunds when the post-waterfall allocation is below MIN_SALE, so
  // the minimum-fund check and the outcome estimates use the projected allocation,
  // not capped demand (with hop ceilings, hop-0-heavy demand can clear MIN_SALE yet allocate below it).
  const estimate = estimateAllocation(hopStats, cappedDemand, 0n, config)
  const projectedAllocUsdc = estimate.totalAllocUsdc
  const belowMin = projectsRefundMode(hopStats, cappedDemand, config)
  const meetsMin = !belowMin
  const meetsElastic = cappedDemand >= ELASTIC_TRIGGER
  const actualSaleSize = estimate.effectiveSaleSize
  // ARM distributed at 1:1 with USDC (ARM_PRICE = 1 USDC per ARM)
  const armToDistribute = projectedAllocUsdc * 10n ** 12n // Convert from 6 decimals (USDC) to 18 decimals (ARM)
  const refundEstimate = totalCommitted > projectedAllocUsdc ? totalCommitted - projectedAllocUsdc : 0n
  // Profiles whose contract pays the launch team at finalize show the proceeds split.
  const teamPayment = projectedLaunchTeamPayment(projectedAllocUsdc, config)
  const paysLaunchTeam = CROWDFUND_CONSTANTS.TEAM_PAYMENT_USDC > 0n

  const handleFinalize = async () => {
    await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.finalize()
    })
  }

  return (
    <div className="rounded border border-border p-3 space-y-3">
      <div className="">Finalize Crowdfund</div>

      {/* Demand checks */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span>Capped demand: <span className="">{formatUsdc(cappedDemand)}</span></span>
        </div>
        <div className="flex items-center justify-between">
          <span>Projected allocation: <span className="">{formatUsdc(projectedAllocUsdc)}</span></span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Minimum fund: {formatUsdc(MIN_SALE)}</span>
          <span className={meetsMin ? 'text-success' : 'text-destructive'}>{meetsMin ? '✓ Met' : '✗ Not met'}</span>
        </div>
        {canExpand && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Elastic trigger: {formatUsdc(ELASTIC_TRIGGER)}</span>
            <span className={meetsElastic ? 'text-success' : 'text-muted-foreground'}>
              {meetsElastic ? '✓ Met (EXPANDED)' : '✗ Not met (BASE)'}
            </span>
          </div>
        )}
      </div>

      {/* Expected outcome */}
      {meetsMin && (
        <div className="rounded bg-muted/50 p-2 space-y-1">
          <div className="text-muted-foreground">Expected outcome (estimates):</div>
          <div>
            Sale size: <span className="">{formatUsdc(actualSaleSize)}</span>
            {canExpand && ` (${meetsElastic ? 'EXPANDED' : 'BASE'})`}
          </div>
          <div>ARM to distribute: <span className="">~{formatArm(armToDistribute)}</span></div>
          <div>Net proceeds: <span className="">~{formatUsdc(projectedAllocUsdc)}</span></div>
          {paysLaunchTeam && (
            <>
              <div><span>Launch team payment:</span> <span className="">~{formatUsdc(teamPayment)}</span></div>
              <div><span>Treasury:</span> <span className="">~{formatUsdc(projectedAllocUsdc - teamPayment)}</span></div>
            </>
          )}
          {refundEstimate > 0n && (
            <div>Refunds: <span className="text-amber-500">~{formatUsdc(refundEstimate)}</span> (oversubscription)</div>
          )}
        </div>
      )}

      {/* Below-min: finalization enters refund mode */}
      {belowMin && (
        <div className="rounded bg-amber-500/10 border border-amber-500/30 p-2 text-amber-600 space-y-1">
          <div>Projected allocation is below the minimum fund ({formatUsdc(MIN_SALE)}). Finalizing will enter refund mode — all participants receive full USDC refunds.</div>
        </div>
      )}

      <button
        className="w-full rounded bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={tx.state.status === 'pending' || tx.state.status === 'submitted'}
        onClick={handleFinalize}
      >
        {belowMin ? 'Finalize (Refund Mode)' : 'Finalize'}
      </button>
      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="Crowdfund finalized!" />
    </div>
  )
}
