// ABOUTME: Client-side estimation of hop-level allocations mirroring the contract's _computeHopAllocations.
// ABOUTME: Drives pre-finalization allocation estimates and the refund-mode projection (UIs + indexer alerts).

import { CROWDFUND_CONSTANTS, HOP_CONFIGS, type CrowdfundConstants, type HopConfig } from './constants.js'

/** The sale constants and hop configs the waterfall reads. Defaults to the active
 *  profile; tests pass another profile's values to check it without a rebuild. */
export interface AllocationConfig {
  constants: CrowdfundConstants
  hopConfigs: readonly [HopConfig, HopConfig, HopConfig]
}

const ACTIVE_CONFIG: AllocationConfig = { constants: CROWDFUND_CONSTANTS, hopConfigs: HOP_CONFIGS }

/** The per-hop aggregate the waterfall needs: on-chain capped demand at that hop.
 *  `HopStatsData` satisfies it; the indexer builds it from graph nodes. */
export interface HopAllocationStats {
  cappedCommitted: bigint
}

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
 *   1. Reserve the complete hop-2 floor (base + extra) off the top
 *   2. Apply hop-0 ceiling (BPS of the base pool, less the extra hop-2 floor)
 *   3. Roll over leftover to hop-1
 *   4. Roll over leftover to hop-2 (floor + leftover)
 *
 * Pre-finalization, saleSize is 0 — use BASE_SALE or MAX_SALE based on
 * whether capped demand meets the elastic trigger.
 */
export function estimateAllocation(
  hopStats: readonly HopAllocationStats[],
  cappedDemand: bigint,
  saleSize: bigint,
  config: AllocationConfig = ACTIVE_CONFIG,
): AllocationEstimate {
  const { constants, hopConfigs } = config
  // Determine effective sale size
  let effectiveSaleSize: bigint
  if (saleSize > 0n) {
    effectiveSaleSize = saleSize
  } else if (cappedDemand >= constants.ELASTIC_TRIGGER) {
    effectiveSaleSize = constants.MAX_SALE
  } else {
    effectiveSaleSize = constants.BASE_SALE
  }

  const hop2Floor = (effectiveSaleSize * BigInt(
    constants.HOP2_BASE_FLOOR_BPS + constants.HOP2_EXTRA_FLOOR_BPS,
  )) / 10_000n
  const available = effectiveSaleSize - hop2Floor
  const basePool = (effectiveSaleSize * BigInt(10_000 - constants.HOP2_BASE_FLOOR_BPS)) / 10_000n

  // Hop-0
  const hop0Ceiling =
    (basePool * BigInt(hopConfigs[0].ceilingBps)) / 10_000n -
    (effectiveSaleSize * BigInt(constants.HOP2_EXTRA_FLOOR_BPS)) / 10_000n
  const hop0Demand = hopStats[0]?.cappedCommitted ?? 0n
  const hop0Alloc = hop0Demand <= hop0Ceiling ? hop0Demand : hop0Ceiling
  const hop0Leftover = hop0Ceiling - hop0Alloc
  const remainingAvailable = available - hop0Alloc

  // Hop-1
  const hop1BaseCeiling = (basePool * BigInt(hopConfigs[1].ceilingBps)) / 10_000n
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

/**
 * Whether finalize() would enter refund mode for the given capped demand.
 * The contract refunds when the post-waterfall allocation is below MIN_SALE.
 * Under profiles whose hop ceilings can hold allocation below demand, capped
 * demand alone is not enough: in Launch 1 (mainnet profile) hop-0's ceiling sits
 * below MIN_SALE at both sale sizes, so hop-0-heavy demand can clear MIN_SALE yet
 * allocate below it. (Under the relaunch profile allocation equals
 * min(capped demand, sale size), so the two checks agree.) Allocation never
 * exceeds capped demand, so this also covers the contract's earlier
 * `cappedDemand < MIN_SALE` branch.
 * Pre-finalize only; afterwards the contract's `refundMode` flag is authoritative.
 */
export function projectsRefundMode(
  hopStats: readonly HopAllocationStats[],
  cappedDemand: bigint,
  config: AllocationConfig = ACTIVE_CONFIG,
): boolean {
  const { totalAllocUsdc } = estimateAllocation(hopStats, cappedDemand, 0n, config)
  return totalAllocUsdc < config.constants.MIN_SALE
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
  hopStats: readonly HopAllocationStats[],
  cappedDemand: bigint,
  saleSize: bigint,
  config: AllocationConfig = ACTIVE_CONFIG,
): bigint {
  if (positions.length === 0) return 0n
  const { perHopCeiling } = estimateAllocation(hopStats, cappedDemand, saleSize, config)
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
