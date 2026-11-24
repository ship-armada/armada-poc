// ABOUTME: Unit tests for estimateUserArmAllocation — pro-rata projection of a wallet's ARM.
// ABOUTME: Covers undersubscribed (full credit), oversubscribed (pro-rata), per-hop cap, and multi-hop sum.

import { describe, it, expect } from 'vitest'
import {
  estimateAllocation,
  estimateUserArmAllocation,
  allocationMatchesDemand,
  hopCeilingLabel,
  projectedLaunchTeamPayment,
  projectsRefundMode,
  type UserHopPosition,
} from './allocation.js'
import {
  CONSTANTS_BY_PROFILE,
  CROWDFUND_CONSTANTS,
  HOP_CONFIGS,
  HOP_CONFIGS_BY_PROFILE,
} from './constants.js'
import type { HopStatsData } from '../components/StatsBar.js'

const ARM_FROM_USDC = 10n ** 12n // 1 USDC (6 dec) → 1 ARM (18 dec)

function emptyHopStats(): HopStatsData[] {
  return [
    { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
    { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
    { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
  ]
}

const USDC = 10n ** 6n

function estimateForDemands(
  hop0: bigint,
  hop1: bigint,
  hop2: bigint,
  saleSize = 0n,
) {
  const stats = emptyHopStats()
  stats[0].cappedCommitted = hop0
  stats[1].cappedCommitted = hop1
  stats[2].cappedCommitted = hop2
  return estimateAllocation(stats, hop0 + hop1 + hop2, saleSize)
}

describe('estimateAllocation', () => {
  it('matches the July 2026 base and expanded ceiling anchors', () => {
    const base = estimateForDemands(0n, 0n, 0n, CROWDFUND_CONSTANTS.BASE_SALE)
    expect(base.perHopCeiling[0]).toBe(564_000n * USDC)
    expect(base.perHopCeiling[1]).toBe(1_020_000n * USDC)
    expect(base.perHopCeiling[2]).toBe(1_200_000n * USDC)

    const expanded = estimateForDemands(0n, 0n, 0n, CROWDFUND_CONSTANTS.MAX_SALE)
    expect(expanded.perHopCeiling[0]).toBe(846_000n * USDC)
    expect(expanded.perHopCeiling[1]).toBe(1_530_000n * USDC)
    expect(expanded.perHopCeiling[2]).toBe(1_800_000n * USDC)
  })

  it('conserves allocations over empty, partial, rollover-heavy, and saturated demands', () => {
    const levels = [0n, 100_000n * USDC, 600_000n * USDC, 2_000_000n * USDC]
    for (const saleSize of [CROWDFUND_CONSTANTS.BASE_SALE, CROWDFUND_CONSTANTS.MAX_SALE]) {
      const hop2Floor = (saleSize * 1500n) / 10_000n
      const available = saleSize - hop2Floor
      for (const hop0 of levels) for (const hop1 of levels) for (const hop2 of levels) {
        const result = estimateForDemands(hop0, hop1, hop2, saleSize)
        const totalAllocated = result.totalAllocUsdc
        const totalCommitted = hop0 + hop1 + hop2
        const totalRefunded = totalCommitted - totalAllocated
        expect(totalAllocated).toBeGreaterThanOrEqual(0n)
        expect(totalAllocated).toBeLessThanOrEqual(saleSize)
        expect(totalAllocated + totalRefunded).toBe(totalCommitted)
        expect(result.perHopAlloc[0]).toBeLessThanOrEqual(result.perHopCeiling[0])
        expect(result.perHopAlloc[1]).toBeLessThanOrEqual(available - result.perHopAlloc[0])
        expect(result.perHopAlloc[2]).toBeGreaterThanOrEqual(hop2 < hop2Floor ? hop2 : hop2Floor)
      }
    }
  })

  it('preserves forward-only rollover and full-sale allocation under saturation', () => {
    const saturatedBase = estimateForDemands(2_000_000n * USDC, 2_000_000n * USDC, 2_000_000n * USDC, CROWDFUND_CONSTANTS.BASE_SALE)
    const saturatedExpanded = estimateForDemands(2_000_000n * USDC, 2_000_000n * USDC, 2_000_000n * USDC, CROWDFUND_CONSTANTS.MAX_SALE)
    expect(saturatedBase.totalAllocUsdc).toBe(CROWDFUND_CONSTANTS.BASE_SALE)
    expect(saturatedExpanded.totalAllocUsdc).toBe(CROWDFUND_CONSTANTS.MAX_SALE)

    const hop1Rollover = estimateForDemands(0n, 2_000_000n * USDC, 0n, CROWDFUND_CONSTANTS.BASE_SALE)
    expect(hop1Rollover.perHopAlloc[1]).toBe(1_020_000n * USDC)

    const hop2Rollover = estimateForDemands(564_000n * USDC, 0n, 2_000_000n * USDC, CROWDFUND_CONSTANTS.BASE_SALE)
    expect(hop2Rollover.perHopAlloc[2]).toBe(636_000n * USDC)
  })

  it('keeps hop-0-only demand below the minimum at both sale sizes', () => {
    const base = estimateForDemands(2_000_000n * USDC, 0n, 0n, CROWDFUND_CONSTANTS.BASE_SALE)
    const expanded = estimateForDemands(2_000_000n * USDC, 0n, 0n, CROWDFUND_CONSTANTS.MAX_SALE)
    expect(base.totalAllocUsdc).toBe(564_000n * USDC)
    expect(expanded.totalAllocUsdc).toBe(846_000n * USDC)
    expect(base.totalAllocUsdc).toBeLessThan(CROWDFUND_CONSTANTS.MIN_SALE)
    expect(expanded.totalAllocUsdc).toBeLessThan(CROWDFUND_CONSTANTS.MIN_SALE)
  })
})

describe('estimateAllocation — Launch 1 (mainnet profile) waterfall vectors', () => {
  // WHY: the mainnet profile still serves the deployed Launch 1 crowdfund, whose contract used
  // 60/45 ceilings and a 15% hop-2 floor. These pin the off-chain mirror to that deployed
  // waterfall. (The current Solidity source carries the relaunch constants; its differential table
  // is mirrored by the relaunch block below.)
  const K = 1_000n * USDC
  const B = CROWDFUND_CONSTANTS.BASE_SALE
  const M = CROWDFUND_CONSTANTS.MAX_SALE
  const cases: Array<[bigint, bigint, bigint, bigint, bigint]> = [
    // saleSize, d0, d1, d2, expectedTotal
    [B, 2_000n * K, 0n, 0n, 564n * K],
    [M, 2_000n * K, 0n, 0n, 846n * K],
    [B, 2_000n * K, 2_000n * K, 2_000n * K, 1_200n * K],
    [M, 2_000n * K, 2_000n * K, 2_000n * K, 1_800n * K],
    [B, 564n * K, 0n, 2_000n * K, 1_200n * K],
    [B, 0n, 2_000n * K, 0n, 1_020n * K],
    [B, 1_050n * K, 436n * K, 0n, 1_000n * K],
    [B, 1_050n * K, 435n * K, 0n, 999n * K],
    [M, 1_500n * K, 0n, 0n, 846n * K],
  ]
  it.each(cases)('saleSize=%s d=(%s,%s,%s) → %s', (saleSize, d0, d1, d2, expected) => {
    expect(estimateForDemands(d0, d1, d2, saleSize).totalAllocUsdc).toBe(expected)
  })
})

describe('estimateAllocation — economic thresholds', () => {
  it('selects BASE below the elastic trigger and MAX at/above it (matches contract `capped >= ELASTIC_TRIGGER`)', () => {
    // saleSize 0 → estimateAllocation picks the sale size from capped demand vs ELASTIC_TRIGGER.
    const below = estimateForDemands(CROWDFUND_CONSTANTS.ELASTIC_TRIGGER - 1n, 0n, 0n)
    const at = estimateForDemands(CROWDFUND_CONSTANTS.ELASTIC_TRIGGER, 0n, 0n)
    expect(below.effectiveSaleSize).toBe(CROWDFUND_CONSTANTS.BASE_SALE)
    expect(at.effectiveSaleSize).toBe(CROWDFUND_CONSTANTS.MAX_SALE)
  })

  it('projected allocation straddles MIN_SALE at the refund boundary (finalize uses `< MIN_SALE`)', () => {
    const atMin = estimateForDemands(1_050_000n * USDC, 436_000n * USDC, 0n, CROWDFUND_CONSTANTS.BASE_SALE)
    const belowMin = estimateForDemands(1_050_000n * USDC, 435_000n * USDC, 0n, CROWDFUND_CONSTANTS.BASE_SALE)
    expect(atMin.totalAllocUsdc).toBe(CROWDFUND_CONSTANTS.MIN_SALE) // == $1M → finalize() succeeds
    expect(belowMin.totalAllocUsdc).toBeLessThan(CROWDFUND_CONSTANTS.MIN_SALE) // < $1M → refund mode
  })
})

describe('projectsRefundMode', () => {
  // WHY: finalize() enters refundMode when the post-waterfall allocation is below MIN_SALE,
  // not when capped demand is. Hop-0's ceiling ($564k base / $846k expanded) sits below
  // MIN_SALE, so hop-0-heavy demand can clear $1M yet still refund. The committer, admin
  // and indexer must all predict the contract's outcome, so they share this one check.
  function projectFor(hop0: bigint, hop1: bigint, hop2: bigint): boolean {
    const hopStats = [
      { cappedCommitted: hop0 },
      { cappedCommitted: hop1 },
      { cappedCommitted: hop2 },
    ]
    return projectsRefundMode(hopStats, hop0 + hop1 + hop2)
  }
  const K = 1_000n * USDC

  it('projects refund when capped demand is below MIN_SALE', () => {
    expect(projectFor(500n * K, 200n * K, 100n * K)).toBe(true)
  })

  it('projects refund when hop-0-heavy demand clears MIN_SALE but allocates below it (base)', () => {
    // $1.05M capped → $564k + $100k + $50k = $714k allocated.
    expect(projectFor(900n * K, 100n * K, 50n * K)).toBe(true)
  })

  it('projects refund when hop-0-only demand triggers expansion but allocates below MIN_SALE', () => {
    // $1.5M capped → MAX_SALE, but hop-0 alone allocates only $846k.
    expect(projectFor(1_500n * K, 0n, 0n)).toBe(true)
  })

  it('does not project refund when demand is spread across hops', () => {
    expect(projectFor(564n * K, 300n * K, 200n * K)).toBe(false)
  })

  it('matches the contract boundary: exactly MIN_SALE allocated succeeds (`< MIN_SALE` refunds)', () => {
    expect(projectFor(1_050n * K, 436n * K, 0n)).toBe(false) // $1,000k allocated
    expect(projectFor(1_050n * K, 435n * K, 0n)).toBe(true) // $999k allocated
  })
})

describe('estimateUserArmAllocation', () => {
  it('returns 0 for empty positions', () => {
    expect(estimateUserArmAllocation([], emptyHopStats(), 0n, 0n)).toBe(0n)
  })

  it('credits the full position when the hop is undersubscribed', () => {
    const committed = 10_000n * 10n ** 6n // $10k
    const hopStats = emptyHopStats()
    hopStats[1].cappedCommitted = 100_000n * 10n ** 6n // well under hop-1 ceiling
    const positions: UserHopPosition[] = [
      {
        hop: 1,
        committed,
        effectiveCap: HOP_CONFIGS[1].capUsdc * 3n,
      },
    ]
    const arm = estimateUserArmAllocation(
      positions,
      hopStats,
      hopStats[1].cappedCommitted,
      0n,
    )
    expect(arm).toBe(committed * ARM_FROM_USDC)
  })

  it("caps the user's contribution at effectiveCap", () => {
    const effectiveCap = HOP_CONFIGS[0].capUsdc // 1 invite × $15k = $15k cap
    const committed = 25_000n * 10n ** 6n // over-committed; only the capped portion counts
    const hopStats = emptyHopStats()
    hopStats[0].cappedCommitted = effectiveCap
    const arm = estimateUserArmAllocation(
      [{ hop: 0, committed, effectiveCap }],
      hopStats,
      hopStats[0].cappedCommitted,
      0n,
    )
    expect(arm).toBe(effectiveCap * ARM_FROM_USDC)
  })

  it('pro-rates when the hop is oversubscribed', () => {
    // Push hop-1 demand high enough to exceed even the leftover-augmented
    // ceiling. With empty hop-0, the unused hop-0 ceiling rolls over into
    // hop-1, so we need demand well above that combined cap to force
    // pro-rata. $2M demand > MAX_SALE-derived hop-1 ceiling (~$1.71M).
    const hopStats = emptyHopStats()
    hopStats[1].cappedCommitted = 2_000_000n * 10n ** 6n
    const cappedDemand = hopStats[1].cappedCommitted

    // Tie expectation to the shared logic; avoids brittle magic numbers.
    const { perHopCeiling } = estimateAllocation(hopStats, cappedDemand, 0n)
    expect(perHopCeiling[1]).toBeLessThan(hopStats[1].cappedCommitted) // sanity

    const userCapped = HOP_CONFIGS[1].capUsdc
    const expectedArm =
      ((userCapped * perHopCeiling[1]) / hopStats[1].cappedCommitted) *
      ARM_FROM_USDC

    const arm = estimateUserArmAllocation(
      [{ hop: 1, committed: userCapped, effectiveCap: userCapped }],
      hopStats,
      cappedDemand,
      0n,
    )
    expect(arm).toBe(expectedArm)
    expect(arm).toBeLessThan(userCapped * ARM_FROM_USDC)
  })

  it('sums across multiple hop positions', () => {
    const hop0Commit = 5_000n * 10n ** 6n
    const hop1Commit = 2_000n * 10n ** 6n
    const hopStats = emptyHopStats()
    hopStats[0].cappedCommitted = hop0Commit
    hopStats[1].cappedCommitted = hop1Commit
    const positions: UserHopPosition[] = [
      { hop: 0, committed: hop0Commit, effectiveCap: HOP_CONFIGS[0].capUsdc },
      { hop: 1, committed: hop1Commit, effectiveCap: HOP_CONFIGS[1].capUsdc },
    ]
    const arm = estimateUserArmAllocation(
      positions,
      hopStats,
      hop0Commit + hop1Commit,
      0n,
    )
    expect(arm).toBe((hop0Commit + hop1Commit) * ARM_FROM_USDC)
  })

  it('returns 0 when the user has no committed amount', () => {
    const hopStats = emptyHopStats()
    const positions: UserHopPosition[] = [
      { hop: 0, committed: 0n, effectiveCap: HOP_CONFIGS[0].capUsdc },
    ]
    expect(estimateUserArmAllocation(positions, hopStats, 0n, 0n)).toBe(0n)
  })
})

describe('estimateAllocation — relaunch profile cross-language differential vectors', () => {
  // WHY: this is the off-chain mirror of the relaunch contract's _computeHopAllocations, which
  // drives the committer/admin/indexer refund projection. This SAME (saleSize, demand) → total table
  // is asserted against the Solidity source of truth in
  // test-foundry/CrowdfundWaterfallMath.t.sol::test_differentialVectors. Any drift between the two
  // implementations fails one side. Keep the two tables in lockstep.
  const relaunch = { constants: CONSTANTS_BY_PROFILE.relaunch, hopConfigs: HOP_CONFIGS_BY_PROFILE.relaunch }
  const K = 1_000n * USDC
  const S = CONSTANTS_BY_PROFILE.relaunch.BASE_SALE
  const cases: Array<[bigint, bigint, bigint, bigint, bigint]> = [
    // saleSize, d0, d1, d2, expectedTotal
    [S, 2_000n * K, 0n, 0n, 1_800n * K], // hop-0 oversub, no hop-2 → takes the whole sale
    [S, 2_000n * K, 2_000n * K, 2_000n * K, 1_800n * K], // saturated → full sale
    [S, 2_000n * K, 0n, 50n * K, 1_800n * K], // unused reserve rolls to hop-0
    [S, 564n * K, 0n, 2_000n * K, 1_800n * K], // unused hop-0 rolls to hop-2
    [S, 0n, 2_000n * K, 0n, 1_800n * K], // hop-0 empty → hop-1 gets the whole sale
    [S, 1_200n * K, 0n, 900n * K, 1_800n * K], // hop-2 gets reserve + $300k rollover
    [S, 1_050n * K, 436n * K, 0n, 1_486n * K], // under the sale → everyone filled
    [S, 200n * K, 0n, 50n * K, 250n * K], // exactly MIN_SALE
    [S, 200n * K, 0n, 49n * K, 249n * K], // $1K less → below MIN_SALE
    [S, 0n, 0n, 0n, 0n], // no demand
  ]
  it.each(cases)('saleSize=%s d=(%s,%s,%s) → %s', (saleSize, d0, d1, d2, expected) => {
    const stats = emptyHopStats()
    stats[0].cappedCommitted = d0
    stats[1].cappedCommitted = d1
    stats[2].cappedCommitted = d2
    expect(estimateAllocation(stats, d0 + d1 + d2, saleSize, relaunch).totalAllocUsdc).toBe(expected)
  })

  // WHY: per-hop amounts drive the status tables and each user's pro-rata projection, so they must
  // match the contract's finalCeilings: hop-2 first for its $300k reserve, hop-0 up to the rest,
  // hop-1 next, then hop-2's excess; unused capacity rolls both ways.
  it.each([
    // d0, d1, d2 → [hop0, hop1, hop2]
    [2_000n, 0n, 2_000n, [1_500n, 0n, 300n]], // both oversubscribed: split at the reserve
    [2_000n, 0n, 50n, [1_750n, 0n, 50n]], // unused reserve rolls to hop-0
    [564n, 0n, 2_000n, [564n, 0n, 1_236n]], // unused hop-0 capacity rolls to hop-2
    [1_200n, 0n, 900n, [1_200n, 0n, 600n]], // hop-2 reserve plus the $300k left over
    [1_000n, 2_000n, 100n, [1_000n, 700n, 100n]], // hop-1 fills after hop-0, before hop-2's excess
  ] as Array<[bigint, bigint, bigint, bigint[]]>)('per-hop allocation for d=(%sK,%sK,%sK)', (d0, d1, d2, expected) => {
    const stats = emptyHopStats()
    stats[0].cappedCommitted = d0 * K
    stats[1].cappedCommitted = d1 * K
    stats[2].cappedCommitted = d2 * K
    const est = estimateAllocation(stats, (d0 + d1 + d2) * K, 0n, relaunch)
    expect(est.perHopAlloc).toEqual(expected.map((v) => v * K))
    // The sale is filled, so each hop's ceiling is its allocation, as in the contract's finalCeilings.
    expect(est.perHopCeiling).toEqual(est.perHopAlloc)
  })

  // WHY: the status tables show fill as capped demand / ceiling. With capacity left over, any hop
  // could absorb it, so a hop's ceiling is its allocation plus the unallocated remainder; an
  // undersubscribed hop then reads below 100% instead of looking full.
  it('adds unallocated capacity to every hop ceiling when the sale is undersubscribed', () => {
    const stats = emptyHopStats()
    stats[0].cappedCommitted = 1_000n * K
    stats[2].cappedCommitted = 100n * K
    const est = estimateAllocation(stats, 1_100n * K, 0n, relaunch)
    expect(est.perHopAlloc).toEqual([1_000n * K, 0n, 100n * K])
    expect(est.perHopCeiling).toEqual([1_700n * K, 700n * K, 800n * K])
  })

  // WHY: pre-finalization the projection passes saleSize = 0 and picks the sale size from capped
  // demand. With BASE_SALE == MAX_SALE that is $1.8M on both sides of the trigger.
  it('uses the $1.8M sale size on both sides of the elastic trigger', () => {
    const below = emptyHopStats()
    below[0].cappedCommitted = 1_000n * K
    expect(estimateAllocation(below, 1_000n * K, 0n, relaunch).effectiveSaleSize).toBe(S)
    const above = emptyHopStats()
    above[0].cappedCommitted = 2_000n * K
    expect(estimateAllocation(above, 2_000n * K, 0n, relaunch).effectiveSaleSize).toBe(S)
  })

  // WHY: the relaunch refunds only when capped demand is below the $250K minimum (allocation equals
  // min(capped demand, sale size)); the projection must flip at exactly that boundary.
  it('projects refund mode exactly below the $250K minimum', () => {
    const at = emptyHopStats()
    at[0].cappedCommitted = 200n * K
    at[2].cappedCommitted = 50n * K
    expect(projectsRefundMode(at, 250n * K, relaunch)).toBe(false)
    const under = emptyHopStats()
    under[0].cappedCommitted = 200n * K
    under[2].cappedCommitted = 49n * K
    expect(projectsRefundMode(under, 249n * K, relaunch)).toBe(true)
  })

  // WHY: the hop-2 reserve means Backer demand that fills the sale cannot crowd the Community tier
  // out: a Community contributor inside the reserve is projected their full allocation.
  it('projects full ARM for a Community contributor inside the reserve when Backer demand fills the sale', () => {
    const stats = emptyHopStats()
    stats[0].cappedCommitted = 1_800n * K
    stats[2].cappedCommitted = 10n * K
    const invited: UserHopPosition[] = [{ hop: 2, committed: 10n * K, effectiveCap: 10n * K }]
    expect(estimateUserArmAllocation(invited, stats, 1_810n * K, 0n, relaunch)).toBe(10n * K * ARM_FROM_USDC)
  })

  // WHY: when both tiers are oversubscribed, pro-rata happens within a tier against that tier's
  // allocation: $600K of Community demand shares the $300K reserve, so a $10K position gets $5K.
  it('pro-rates a Community contributor against the reserve when both tiers are oversubscribed', () => {
    const stats = emptyHopStats()
    stats[0].cappedCommitted = 2_000n * K
    stats[2].cappedCommitted = 600n * K
    const invited: UserHopPosition[] = [{ hop: 2, committed: 10n * K, effectiveCap: 10n * K }]
    expect(estimateUserArmAllocation(invited, stats, 2_600n * K, 0n, relaunch)).toBe(5n * K * ARM_FROM_USDC)
  })
})

describe('hopCeilingLabel', () => {
  // WHY: the per-hop tables label how each hop's capacity is set. The reserve model has no bps
  // ceilings (ceilingBps is 0), so printing "0%" would be wrong: hop 2 shows its reserve and the
  // other hops the remainder of the sale. The Launch 1 waterfall keeps its bps ceilings and floor.
  it('labels the reserve model by reserve and remainder, and the waterfall by bps and floor', () => {
    const relaunch = { constants: CONSTANTS_BY_PROFILE.relaunch, hopConfigs: HOP_CONFIGS_BY_PROFILE.relaunch }
    expect([0, 1, 2].map((h) => hopCeilingLabel(h, relaunch))).toEqual(['Remainder', 'Remainder', '$300K reserve'])
    const mainnet = { constants: CONSTANTS_BY_PROFILE.mainnet, hopConfigs: HOP_CONFIGS_BY_PROFILE.mainnet }
    expect([0, 1, 2].map((h) => hopCeilingLabel(h, mainnet))).toEqual(['60%', '45%', 'Floor'])
    const noFloor = {
      constants: { ...CONSTANTS_BY_PROFILE.mainnet, HOP2_BASE_FLOOR_BPS: 0, HOP2_EXTRA_FLOOR_BPS: 0 },
      hopConfigs: HOP_CONFIGS_BY_PROFILE.mainnet,
    }
    expect(hopCeilingLabel(2, noFloor)).toBe('Rollover')
  })
})

describe('projectedLaunchTeamPayment', () => {
  // WHY: the relaunch pays the launch team min($250K, proceeds) at finalize, before the treasury;
  // the admin projection must show that split, and nothing on profiles that pay no team.
  it('is min($250K, allocation) on the relaunch and 0 elsewhere', () => {
    const relaunch = { constants: CONSTANTS_BY_PROFILE.relaunch, hopConfigs: HOP_CONFIGS_BY_PROFILE.relaunch }
    expect(projectedLaunchTeamPayment(1_000_000n * USDC, relaunch)).toBe(250_000n * USDC)
    expect(projectedLaunchTeamPayment(250_000n * USDC, relaunch)).toBe(250_000n * USDC)
    expect(projectedLaunchTeamPayment(100_000n * USDC, relaunch)).toBe(100_000n * USDC)
    const mainnet = { constants: CONSTANTS_BY_PROFILE.mainnet, hopConfigs: HOP_CONFIGS_BY_PROFILE.mainnet }
    expect(projectedLaunchTeamPayment(1_000_000n * USDC, mainnet)).toBe(0n)
  })
})

describe('allocationMatchesDemand', () => {
  // WHY: when allocation equals min(capped demand, sale size), copy about per-hop limits and refunds
  // "after allocation" is false; the UI keys that copy off this. The relaunch's reserve model has
  // the property (unused capacity rolls both ways); Launch 1's floor/ceiling waterfall does not.
  it('is true for the relaunch reserve model and false for the Launch 1 waterfall', () => {
    expect(allocationMatchesDemand({ constants: CONSTANTS_BY_PROFILE.relaunch, hopConfigs: HOP_CONFIGS_BY_PROFILE.relaunch })).toBe(true)
    expect(allocationMatchesDemand({ constants: CONSTANTS_BY_PROFILE.mainnet, hopConfigs: HOP_CONFIGS_BY_PROFILE.mainnet })).toBe(false)
    expect(allocationMatchesDemand({ constants: CONSTANTS_BY_PROFILE.medi, hopConfigs: HOP_CONFIGS_BY_PROFILE.medi })).toBe(false)
  })
})
