// ABOUTME: Client-side estimation of hop-level allocations mirroring the contract's _computeHopAllocations.
// ABOUTME: Used pre-finalization to show estimated total allocation (post-ceiling) in the UI.

import { CROWDFUND_CONSTANTS, HOP_CONFIGS } from './constants.js'
import type { HopStatsData } from '../components/StatsBar.js'

export interface AllocationEstimate {
  /** Total USDC that would be allocated (after hop ceilings) */
  totalAllocUsdc: bigint
  /** Per-hop allocated amounts [hop0, hop1, hop2] */
  perHopAlloc: [bigint, bigint, bigint]
  /** Per-hop effective ceilings (max each hop can absorb) [hop0, hop1, hop2] */
  perHopCeiling: [bigint, bigint, bigint]
  /** Effective sale size used for the estimate */
  effectiveSaleSize: bigint
}

/**
 * Estimate hop-level allocations from current capped demand.
 * Mirrors the contract's _computeHopAllocations logic:
 *   1. Reserve hop-2 floor off the top
 *   2. Apply hop-0 ceiling (BPS of available pool)
 *   3. Roll over leftover to hop-1
 *   4. Roll over leftover to hop-2 (floor + leftover)
 *
 * Pre-finalization, saleSize is 0 — use BASE_SALE or MAX_SALE based on
 * whether capped demand meets the elastic trigger.
 */
export function estimateAllocation(hopStats: HopStatsData[], cappedDemand: bigint, saleSize: bigint): AllocationEstimate {
  // Determine effective sale size
  let effectiveSaleSize: bigint
  if (saleSize > 0n) {
    effectiveSaleSize = saleSize
  } else if (cappedDemand >= CROWDFUND_CONSTANTS.ELASTIC_TRIGGER) {
    effectiveSaleSize = CROWDFUND_CONSTANTS.MAX_SALE
  } else {
    effectiveSaleSize = CROWDFUND_CONSTANTS.BASE_SALE
  }

  const hop2Floor = (effectiveSaleSize * BigInt(CROWDFUND_CONSTANTS.HOP2_FLOOR_BPS)) / 10_000n
  const available = effectiveSaleSize - hop2Floor

  // Hop-0
  const hop0Ceiling = (available * BigInt(HOP_CONFIGS[0].ceilingBps)) / 10_000n
  const hop0Demand = hopStats[0]?.cappedCommitted ?? 0n
  const hop0Alloc = hop0Demand <= hop0Ceiling ? hop0Demand : hop0Ceiling
  const hop0Leftover = hop0Ceiling - hop0Alloc
  const remainingAvailable = available - hop0Alloc

  // Hop-1
  const hop1BaseCeiling = (available * BigInt(HOP_CONFIGS[1].ceilingBps)) / 10_000n
  let hop1EffCeiling = hop1BaseCeiling + hop0Leftover
  if (hop1EffCeiling > remainingAvailable) {
    hop1EffCeiling = remainingAvailable
  }
  const hop1Demand = hopStats[1]?.cappedCommitted ?? 0n
  const hop1Alloc = hop1Demand <= hop1EffCeiling ? hop1Demand : hop1EffCeiling
  const hop1Leftover = hop1EffCeiling - hop1Alloc

  // Hop-2
  const hop2EffCeiling = hop2Floor + hop1Leftover
  const hop2Demand = hopStats[2]?.cappedCommitted ?? 0n
  const hop2Alloc = hop2Demand <= hop2EffCeiling ? hop2Demand : hop2EffCeiling

  return {
    totalAllocUsdc: hop0Alloc + hop1Alloc + hop2Alloc,
    perHopAlloc: [hop0Alloc, hop1Alloc, hop2Alloc],
    perHopCeiling: [hop0Ceiling, hop1EffCeiling, hop2EffCeiling],
    effectiveSaleSize,
  }
}

export interface UserHopPosition {
  hop: number
  /** User's raw committed amount in this hop (uncapped). */
  committed: bigint
  /** User's effective per-hop cap = invitesReceived * per-slot cap. */
  effectiveCap: bigint
}

/**
 * Estimate the connected user's projected ARM allocation if the sale
 * finalized now. Pro-rates each hop position against the hop's allocation
 * after ceilings; sums across hops; converts USDC (6 dec) → ARM (18 dec).
 * Returns 0 ARM for an empty positions array.
 */
export function estimateUserArmAllocation(
  positions: UserHopPosition[],
  hopStats: HopStatsData[],
  cappedDemand: bigint,
  saleSize: bigint,
): bigint {
  if (positions.length === 0) return 0n
  const { perHopCeiling } = estimateAllocation(hopStats, cappedDemand, saleSize)
  let acceptedTotal = 0n
  for (const pos of positions) {
    const stats = hopStats[pos.hop]
    if (!stats) continue
    // The user's contribution to capped demand is min(committed, effectiveCap).
    const userCapped =
      pos.committed < pos.effectiveCap ? pos.committed : pos.effectiveCap
    const hopCappedDemand = stats.cappedCommitted
    const hopCeiling = perHopCeiling[pos.hop] ?? 0n
    let accepted: bigint
    if (hopCappedDemand <= hopCeiling) {
      accepted = userCapped
    } else if (hopCappedDemand === 0n) {
      accepted = 0n
    } else {
      accepted = (userCapped * hopCeiling) / hopCappedDemand
    }
    acceptedTotal += accepted
  }
  // 1 USDC (6 dec) → 1 ARM (18 dec)
  return acceptedTotal * 10n ** 12n
}
