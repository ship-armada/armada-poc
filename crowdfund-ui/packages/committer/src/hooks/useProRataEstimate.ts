// ABOUTME: Client-side pro-rata allocation estimate.
// ABOUTME: Calculates estimated ARM allocation based on current demand if finalized now.

import { useMemo } from 'react'
import { HOP_CONFIGS, type HopStatsData } from '@armada/crowdfund-shared'

export interface HopEstimate {
  hop: number
  commitAmount: bigint
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
 * Pure client-side calculation matching the contract's finalize logic.
 */
export function useProRataEstimate(
  commitAmounts: Map<number, bigint>,
  hopStats: HopStatsData[],
  saleSize: bigint,
): UseProRataEstimateResult {
  return useMemo(() => {
    const hopEstimates: HopEstimate[] = []
    let totalEstimatedArm = 0n
    let totalEstimatedRefund = 0n

    for (const [hop, commitAmount] of commitAmounts) {
      if (commitAmount <= 0n || hop >= hopStats.length) continue

      const stats = hopStats[hop]
      const ceilingBps = HOP_CONFIGS[hop]?.ceilingBps ?? 0

      // For hop-2 (ceilingBps=0), allocation is the residual after hop-0 and hop-1
      // This is a simplified estimate — the actual contract logic is more complex
      let hopAllocation: bigint
      if (ceilingBps === 0) {
        // Hop-2 gets the remainder
        const hop0Ceiling = (saleSize * BigInt(HOP_CONFIGS[0].ceilingBps)) / 10_000n
        const hop1Ceiling = (saleSize * BigInt(HOP_CONFIGS[1].ceilingBps)) / 10_000n
        const hop0Used = hopStats[0]?.cappedCommitted > hop0Ceiling ? hop0Ceiling : hopStats[0]?.cappedCommitted ?? 0n
        const hop1Used = hopStats[1]?.cappedCommitted > hop1Ceiling ? hop1Ceiling : hopStats[1]?.cappedCommitted ?? 0n
        hopAllocation = saleSize - hop0Used - hop1Used
        if (hopAllocation < 0n) hopAllocation = 0n
      } else {
        hopAllocation = (saleSize * BigInt(ceilingBps)) / 10_000n
      }

      // Pro-rata within this hop — use totalCommitted (live running total during Active phase)
      const totalDemand = stats.totalCommitted + commitAmount
      let estimatedAccepted: bigint
      if (totalDemand <= hopAllocation) {
        estimatedAccepted = commitAmount
      } else if (totalDemand === 0n) {
        estimatedAccepted = 0n
      } else {
        estimatedAccepted = (commitAmount * hopAllocation) / totalDemand
      }

      const estimatedArm = estimatedAccepted * 10n ** 12n // 1 USDC (6 dec) → 1 ARM (18 dec)
      const estimatedRefund = commitAmount - estimatedAccepted

      const oversubscriptionPct = hopAllocation > 0n
        ? Number((totalDemand * 100n) / hopAllocation)
        : 0

      hopEstimates.push({
        hop,
        commitAmount,
        estimatedAccepted,
        estimatedArm,
        estimatedRefund,
        oversubscriptionPct,
      })

      totalEstimatedArm += estimatedArm
      totalEstimatedRefund += estimatedRefund
    }

    return { hopEstimates, totalEstimatedArm, totalEstimatedRefund }
  }, [commitAmounts, hopStats, saleSize])
}
