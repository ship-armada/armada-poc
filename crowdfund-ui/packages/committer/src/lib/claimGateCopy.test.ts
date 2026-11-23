// ABOUTME: Tests for the below-minimum claim gate message: the "after per-hop allocation limits" clause
// ABOUTME: appears only where hop limits can cause the shortfall (not when allocation matches demand).

import { describe, it, expect } from 'vitest'
import { armAllocationBullet, belowMinimumMessage } from './claimGateCopy'

const MIN = 250_000_000_000n

describe('belowMinimumMessage', () => {
  // WHY: when allocation matches demand (the relaunch) only low demand can miss the minimum, so
  // blaming per-hop limits is false.
  it('omits the per-hop clause when allocation matches demand', () => {
    expect(belowMinimumMessage(true, MIN, 5_000_000_000n)).toBe(
      "The crowdfund didn't reach the $250,000 minimum fund. Once it's finalized, you'll be able to claim a refund of your committed $5,000 from here.",
    )
    expect(belowMinimumMessage(true, MIN, 0n)).toBe(
      "The crowdfund didn't reach the $250,000 minimum fund. Once it's finalized, all committed USDC will be refundable to the addresses that participated.",
    )
  })

  it('keeps the per-hop clause where hop limits apply', () => {
    expect(belowMinimumMessage(false, MIN, 5_000_000_000n)).toContain('minimum fund after per-hop allocation limits.')
  })
})

describe('armAllocationBullet', () => {
  // WHY: the claim tooltip names the allocation limit in the profile's own term: the relaunch's tiers,
  // Launch 1's hops.
  it('names the tier or hop allocation', () => {
    expect(armAllocationBullet('Tier')).toBe("Pro-rata share of the sale, capped at your tier's allocation")
    expect(armAllocationBullet('Hop')).toBe('Pro-rata share of the sale, capped at your hop allocation')
  })
})

