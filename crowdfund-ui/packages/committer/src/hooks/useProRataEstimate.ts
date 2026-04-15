// ABOUTME: Client-side pro-rata allocation estimate.
// ABOUTME: Calculates estimated ARM allocation based on current demand if finalized now.

import { useMemo } from 'react'
import { estimateAllocation, type HopStatsData } from '@armada/crowdfund-shared'

export interface HopEstimate {
  hop: number
  commitAmount: bigint
  existingCommitted: bigint
  totalPosition: bigint
  estimatedAccepted: bigint
  estimatedArm: bigint
  estimatedRefund: bigint
  oversubscriptionPct: number
}

export interface UseProRataEstimateResult {
  hopEstimates: HopEstimate[]
  totalEstimatedArm: bigint
  totalEstimatedRefund: bigint
}

/**
 * Estimate pro-rata allocation for given commit amounts per hop.
 * Uses the shared estimateAllocation() which mirrors the contract's
 * _computeHopAllocations logic including hop-2 floor reservation.
 */
export function useProRataEstimate(
  commitAmounts: Map<number, bigint>,
  existingCommitments: Map<number, bigint>,
  hopStats: HopStatsData[],
  saleSize: bigint,
): UseProRataEstimateResult {
  return useMemo(() => {
    const hopEstimates: HopEstimate[] = []
    let totalEstimatedArm = 0n
    let totalEstimatedRefund = 0n

    // estimateAllocation handles saleSize === 0 (Active phase) by using
    // BASE_SALE or MAX_SALE based on current capped demand.
    const cappedDemand = hopStats.reduce((sum, s) => sum + s.cappedCommitted, 0n)
    const { perHopCeiling } = estimateAllocation(hopStats, cappedDemand, saleSize)

    for (const [hop, commitAmount] of commitAmounts) {
      if (commitAmount <= 0n || hop >= hopStats.length) continue

      const stats = hopStats[hop]
      const hopAllocation = perHopCeiling[hop] ?? 0n
      const existingCommitted = existingCommitments.get(hop) ?? 0n
      const totalPosition = existingCommitted + commitAmount

      // Pro-rata within this hop — estimate for user's TOTAL position (existing + new).
      // stats.totalCommitted already includes existingCommitted, so projected demand
      // after the new commit is stats.totalCommitted + commitAmount.
      const totalDemand = stats.totalCommitted + commitAmount
      let estimatedAccepted: bigint
      if (totalDemand <= hopAllocation) {
        // Hop is not oversubscribed — full position accepted
        estimatedAccepted = totalPosition
      } else if (totalDemand === 0n) {
        estimatedAccepted = 0n
      } else {
        // Pro-rata: user's share of the hop allocation proportional to their total position
        estimatedAccepted = (totalPosition * hopAllocation) / totalDemand
      }

      const estimatedArm = estimatedAccepted * 10n ** 12n // 1 USDC (6 dec) → 1 ARM (18 dec)
      const estimatedRefund = totalPosition - estimatedAccepted

      const oversubscriptionPct = hopAllocation > 0n
        ? Number((totalDemand * 100n) / hopAllocation)
        : 0

      hopEstimates.push({
        hop,
        commitAmount,
        existingCommitted,
        totalPosition,
        estimatedAccepted,
        estimatedArm,
        estimatedRefund,
        oversubscriptionPct,
      })

      totalEstimatedArm += estimatedArm
      totalEstimatedRefund += estimatedRefund
    }

    return { hopEstimates, totalEstimatedArm, totalEstimatedRefund }
  }, [commitAmounts, existingCommitments, hopStats, saleSize])
}
