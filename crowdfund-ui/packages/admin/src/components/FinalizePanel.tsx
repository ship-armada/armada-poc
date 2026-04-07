// ABOUTME: Pre-finalization summary with outcome preview and finalize button.
// ABOUTME: Shows capped demand checks, expected sale outcome, and refund estimates.

import { Contract } from 'ethers'
import type { Signer } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  formatUsdc,
  formatArm,
} from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface FinalizePanelProps {
  signer: Signer | null
  crowdfundAddress: string
  totalCommitted: bigint
  saleSize: bigint
  cappedDemand: bigint
}

export function FinalizePanel({ signer, crowdfundAddress, totalCommitted, saleSize, cappedDemand }: FinalizePanelProps) {
  const tx = useTransactionFlow(signer)
  const { MIN_SALE, ELASTIC_TRIGGER, BASE_SALE, MAX_SALE, ARM_PRICE } = CROWDFUND_CONSTANTS

  const belowMin = cappedDemand < MIN_SALE
  const meetsMin = cappedDemand >= MIN_SALE
  const meetsElastic = cappedDemand >= ELASTIC_TRIGGER
  const effectiveSaleSize = meetsElastic ? MAX_SALE : BASE_SALE
  const actualSaleSize = cappedDemand < effectiveSaleSize ? cappedDemand : effectiveSaleSize
  // ARM distributed at 1:1 with USDC (ARM_PRICE = 1 USDC per ARM)
  const armToDistribute = actualSaleSize * 10n ** 12n // Convert from 6 decimals (USDC) to 18 decimals (ARM)
  const refundEstimate = totalCommitted > actualSaleSize ? totalCommitted - actualSaleSize : 0n

  const handleFinalize = async () => {
    await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.finalize()
    })
  }

  return (
    <div className="rounded border border-border p-3 space-y-3">
      <div className="text-sm font-medium">Finalize Crowdfund</div>

      {/* Demand checks */}
      <div className="text-xs space-y-1">
        <div className="flex items-center justify-between">
          <span>Capped demand: <span className="font-medium">{formatUsdc(cappedDemand)}</span></span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Minimum raise: {formatUsdc(MIN_SALE)}</span>
          <span className={meetsMin ? 'text-success' : 'text-destructive'}>{meetsMin ? '✓ Met' : '✗ Not met'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Elastic trigger: {formatUsdc(ELASTIC_TRIGGER)}</span>
          <span className={meetsElastic ? 'text-success' : 'text-muted-foreground'}>
            {meetsElastic ? '✓ Met (EXPANDED)' : '✗ Not met (BASE)'}
          </span>
        </div>
      </div>

      {/* Expected outcome */}
      {meetsMin && (
        <div className="rounded bg-muted/50 p-2 text-xs space-y-1">
          <div className="font-medium text-muted-foreground">Expected outcome (estimates):</div>
          <div>Sale size: <span className="font-medium">{formatUsdc(actualSaleSize)}</span> ({meetsElastic ? 'EXPANDED' : 'BASE'})</div>
          <div>ARM to distribute: <span className="font-medium">~{formatArm(armToDistribute)}</span></div>
          <div>Net proceeds: <span className="font-medium">~{formatUsdc(actualSaleSize)}</span></div>
          {refundEstimate > 0n && (
            <div>Refunds: <span className="font-medium text-amber-500">~{formatUsdc(refundEstimate)}</span> (oversubscription)</div>
          )}
        </div>
      )}

      {/* Below-min: finalization enters refund mode */}
      {belowMin && (
        <div className="rounded bg-amber-500/10 border border-amber-500/30 p-2 text-xs text-amber-600 space-y-1">
          <div>Capped demand is below the minimum raise ({formatUsdc(MIN_SALE)}). Finalizing will enter refund mode — all participants receive full USDC refunds.</div>
        </div>
      )}

      <button
        className="w-full rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={tx.state.status === 'pending' || tx.state.status === 'submitted'}
        onClick={handleFinalize}
      >
        {belowMin ? 'Finalize (Refund Mode)' : 'Finalize'}
      </button>
      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="Crowdfund finalized!" />
    </div>
  )
}
