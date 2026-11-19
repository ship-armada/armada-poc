// ABOUTME: Client-side estimation of hop-level allocations mirroring the contract's _computeHopAllocations.
// ABOUTME: Drives pre-finalization allocation estimates and the refund-mode projection (UIs + indexer alerts).

import { CROWDFUND_CONSTANTS, HOP_CONFIGS, type CrowdfundConstants, type HopConfig } from './constants.js'
import { formatUsdcShort } from './format.js'

/** The sale constants and hop configs the allocation reads. Defaults to the active
 *  profile; tests pass another profile's values to check it without a rebuild. */
export interface AllocationConfig {
  constants: CrowdfundConstants
  hopConfigs: readonly [HopConfig, HopConfig, HopConfig]
}

const ACTIVE_CONFIG: AllocationConfig = { constants: CROWDFUND_CONSTANTS, hopConfigs: HOP_CONFIGS }

/** The per-hop aggregate the allocation needs: on-chain capped demand at that hop.
 *  `HopStatsData` satisfies it; the indexer builds it from graph nodes. */
export interface HopAllocationStats {
  cappedCommitted: bigint
}

export interface AllocationEstimate {
  /** Total USDC that would be allocated */
  totalAllocUsdc: bigint
  /** Per-hop allocated amounts [hop0, hop1, hop2] */
  perHopAlloc: [bigint, bigint, bigint]
  /** Per-hop effective ceilings (max each hop can absorb given the other hops' demand)
   *  [hop0, hop1, hop2] */
  perHopCeiling: [bigint, bigint, bigint]
  /** Effective sale size used for the estimate */
  effectiveSaleSize: bigint
}

/**
 * Estimate hop-level allocations from current capped demand, mirroring the contract's
 * _computeHopAllocations for the profile's allocation model (see allocateWaterfall and
 * allocateHop2Reserve).
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
  const { constants } = config
  // Determine effective sale size
  let effectiveSaleSize: bigint
  if (saleSize > 0n) {
    effectiveSaleSize = saleSize
  } else if (cappedDemand >= constants.ELASTIC_TRIGGER) {
    effectiveSaleSize = constants.MAX_SALE
  } else {
    effectiveSaleSize = constants.BASE_SALE
  }

  const demand: [bigint, bigint, bigint] = [
    hopStats[0]?.cappedCommitted ?? 0n,
    hopStats[1]?.cappedCommitted ?? 0n,
    hopStats[2]?.cappedCommitted ?? 0n,
  ]
  const { perHopAlloc, perHopCeiling } =
    constants.ALLOCATION_MODEL === 'hop2Reserve'
      ? allocateHop2Reserve(demand, effectiveSaleSize, constants.HOP2_RESERVE_USDC)
      : allocateWaterfall(demand, effectiveSaleSize, config)

  return {
    totalAllocUsdc: perHopAlloc[0] + perHopAlloc[1] + perHopAlloc[2],
    perHopAlloc,
    perHopCeiling,
    effectiveSaleSize,
  }
}

type HopAllocation = Pick<AllocationEstimate, 'perHopAlloc' | 'perHopCeiling'>

/**
 * The floor/ceiling waterfall (Launch 1, medi):
 *   1. Reserve the complete hop-2 floor (base + extra) off the top
 *   2. Apply hop-0 ceiling (BPS of the base pool, less the extra hop-2 floor)
 *   3. Roll over leftover to hop-1
 *   4. Roll over leftover to hop-2 (floor + leftover)
 */
function allocateWaterfall(
  demand: readonly [bigint, bigint, bigint],
  effectiveSaleSize: bigint,
  { constants, hopConfigs }: AllocationConfig,
): HopAllocation {
  const hop2Floor = (effectiveSaleSize * BigInt(
    constants.HOP2_BASE_FLOOR_BPS + constants.HOP2_EXTRA_FLOOR_BPS,
  )) / 10_000n
  const available = effectiveSaleSize - hop2Floor
  const basePool = (effectiveSaleSize * BigInt(10_000 - constants.HOP2_BASE_FLOOR_BPS)) / 10_000n

  // Hop-0
  const hop0Ceiling =
    (basePool * BigInt(hopConfigs[0].ceilingBps)) / 10_000n -
    (effectiveSaleSize * BigInt(constants.HOP2_EXTRA_FLOOR_BPS)) / 10_000n
  const hop0Alloc = demand[0] <= hop0Ceiling ? demand[0] : hop0Ceiling
  const hop0Leftover = hop0Ceiling - hop0Alloc
  const remainingAvailable = available - hop0Alloc

  // Hop-1
  const hop1BaseCeiling = (basePool * BigInt(hopConfigs[1].ceilingBps)) / 10_000n
  let hop1EffCeiling = hop1BaseCeiling + hop0Leftover
  if (hop1EffCeiling > remainingAvailable) {
    hop1EffCeiling = remainingAvailable
  }
  const hop1Alloc = demand[1] <= hop1EffCeiling ? demand[1] : hop1EffCeiling
  const hop1Leftover = hop1EffCeiling - hop1Alloc

  // Hop-2
  const hop2EffCeiling = hop2Floor + hop1Leftover
  const hop2Alloc = demand[2] <= hop2EffCeiling ? demand[2] : hop2EffCeiling

  return {
    perHopAlloc: [hop0Alloc, hop1Alloc, hop2Alloc],
    perHopCeiling: [hop0Ceiling, hop1EffCeiling, hop2EffCeiling],
  }
}

/**
 * The hop-2 reserve model (relaunch):
 *   1. Hop 2 takes min(demand, reserve) first
 *   2. Hop 0 takes up to the rest of the sale (unused reserve included)
 *   3. Hop 1 takes up to what remains
 *   4. Hop 2 takes its excess demand from what remains (unused hop-0/1 capacity)
 * A hop's ceiling is its allocation plus the unallocated remainder (any hop could absorb it). When
 * the sale is filled that is the allocation, as in the contract's finalCeilings, so a hop is
 * pro-rated exactly when its demand exceeds its ceiling.
 */
function allocateHop2Reserve(
  demand: readonly [bigint, bigint, bigint],
  effectiveSaleSize: bigint,
  hop2ReserveUsdc: bigint,
): HopAllocation {
  const min = (a: bigint, b: bigint) => (a < b ? a : b)
  const reserve = min(hop2ReserveUsdc, effectiveSaleSize)
  let hop2Alloc = min(demand[2], reserve)
  let remaining = effectiveSaleSize - hop2Alloc

  const hop0Alloc = min(demand[0], remaining)
  remaining -= hop0Alloc
  const hop1Alloc = min(demand[1], remaining)
  remaining -= hop1Alloc
  const hop2Extra = min(demand[2] - hop2Alloc, remaining)
  hop2Alloc += hop2Extra
  remaining -= hop2Extra

  return {
    perHopAlloc: [hop0Alloc, hop1Alloc, hop2Alloc],
    perHopCeiling: [hop0Alloc + remaining, hop1Alloc + remaining, hop2Alloc + remaining],
  }
}

/**
 * How a hop's capacity is set, for the per-hop status tables: under the hop-2 reserve model hop 2
 * shows its reserve and the other hops "Remainder"; under the waterfall, hops 0/1 show their bps
 * ceiling and hop 2 "Floor" (a configured floor) or "Rollover" (none).
 */
export function hopCeilingLabel(hop: number, config: AllocationConfig = ACTIVE_CONFIG): string {
  const { constants, hopConfigs } = config
  if (constants.ALLOCATION_MODEL === 'hop2Reserve') {
    return hop === 2 ? `${formatUsdcShort(constants.HOP2_RESERVE_USDC)} reserve` : 'Remainder'
  }
  if (hop === 2) return hop2HasFloor(config) ? 'Floor' : 'Rollover'
  return `${(hopConfigs[hop]?.ceilingBps ?? 0) / 100}%`
}

/** Waterfall model only: whether hop 2 has a reserved floor (otherwise it gets the rollover). */
export function hop2HasFloor({ constants }: AllocationConfig = ACTIVE_CONFIG): boolean {
  return (
    constants.ALLOCATION_MODEL === 'waterfall' &&
    constants.HOP2_BASE_FLOOR_BPS + constants.HOP2_EXTRA_FLOOR_BPS > 0
  )
}

/**
 * The launch-team payment finalize() would make from `allocUsdc` of proceeds: min(TEAM_PAYMENT_USDC,
 * proceeds), paid before the treasury (0 on profiles that pay no team). An estimate: the contract
 * first holds back a rounding buffer of at most one unit per node when a hop is pro-rated.
 */
export function projectedLaunchTeamPayment(allocUsdc: bigint, config: AllocationConfig = ACTIVE_CONFIG): bigint {
  const payment = config.constants.TEAM_PAYMENT_USDC
  return allocUsdc < payment ? allocUsdc : payment
}

/**
 * True when allocation equals min(capped demand, sale size): a sale that clears the minimum on
 * demand also clears it on allocation, and there are no per-hop limits beyond the sale size. Holds
 * for the hop-2 reserve model (unused capacity rolls both ways) and for a waterfall with no hop-2
 * floor and 100% hop-0/1 ceilings; not for the Launch 1 waterfall.
 */
export function allocationMatchesDemand(config: AllocationConfig = ACTIVE_CONFIG): boolean {
  const { constants, hopConfigs } = config
  if (constants.ALLOCATION_MODEL === 'hop2Reserve') return true
  return (
    constants.HOP2_BASE_FLOOR_BPS + constants.HOP2_EXTRA_FLOOR_BPS === 0 &&
    hopConfigs[0].ceilingBps >= 10_000 &&
    hopConfigs[1].ceilingBps >= 10_000
  )
}

/**
 * Whether finalize() would enter refund mode for the given capped demand.
 * The contract refunds when the post-allocation total is below MIN_SALE.
 * Under profiles whose hop ceilings can hold allocation below demand, capped
 * demand alone is not enough: in Launch 1 (mainnet profile) hop-0's ceiling sits
 * below MIN_SALE at both sale sizes, so hop-0-heavy demand can clear MIN_SALE yet
 * allocate below it. (Under the relaunch's reserve model allocation equals
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
