// ABOUTME: Unit tests for estimateUserArmAllocation — pro-rata projection of a wallet's ARM.
// ABOUTME: Covers undersubscribed (full credit), oversubscribed (pro-rata), per-hop cap, and multi-hop sum.

import { describe, it, expect } from 'vitest'
import {
  estimateAllocation,
  estimateUserArmAllocation,
  type UserHopPosition,
} from './allocation.js'
import { HOP_CONFIGS } from './constants.js'
import type { HopStatsData } from '../components/StatsBar.js'

const ARM_FROM_USDC = 10n ** 12n // 1 USDC (6 dec) → 1 ARM (18 dec)

function emptyHopStats(): HopStatsData[] {
  return [
    { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
    { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
    { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
  ]
}

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
