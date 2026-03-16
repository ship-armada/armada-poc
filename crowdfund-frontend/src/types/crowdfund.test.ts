// ABOUTME: Unit tests for crowdfund type constants.
// ABOUTME: Validates that TypeScript constants match the Solidity contract values.
import { describe, it, expect } from 'vitest'
import { Phase, CROWDFUND_CONSTANTS } from './crowdfund'

describe('Phase', () => {
  it('has correct numeric values', () => {
    expect(Phase.Setup).toBe(0)
    expect(Phase.Active).toBe(1)
    expect(Phase.Finalized).toBe(2)
    expect(Phase.Canceled).toBe(3)
  })
})

describe('CROWDFUND_CONSTANTS', () => {
  it('has correct sale sizes in USDC (6 decimals)', () => {
    expect(CROWDFUND_CONSTANTS.BASE_SALE).toBe(1_200_000_000_000n)
    expect(CROWDFUND_CONSTANTS.MAX_SALE).toBe(1_800_000_000_000n)
    expect(CROWDFUND_CONSTANTS.MIN_SALE).toBe(1_000_000_000_000n)
  })

  it('ARM_PRICE is $1.00 in USDC terms', () => {
    expect(CROWDFUND_CONSTANTS.ARM_PRICE).toBe(1_000_000n)
  })

  it('has correct duration', () => {
    expect(CROWDFUND_CONSTANTS.SALE_DURATION).toBe(21 * 86400)
  })

  it('hop caps are correct', () => {
    expect(CROWDFUND_CONSTANTS.HOP_CAPS[0]).toBe(15_000_000_000n) // $15,000
    expect(CROWDFUND_CONSTANTS.HOP_CAPS[1]).toBe(4_000_000_000n)  // $4,000
    expect(CROWDFUND_CONSTANTS.HOP_CAPS[2]).toBe(1_000_000_000n)  // $1,000
  })

  it('hop ceilings are overlapping (sum > 100%)', () => {
    const sum = CROWDFUND_CONSTANTS.HOP_CEILING_BPS.reduce((a, b) => a + b, 0)
    expect(sum).toBe(12_500)
  })

  it('hop max invites are correct', () => {
    expect(CROWDFUND_CONSTANTS.HOP_MAX_INVITES[0]).toBe(3)
    expect(CROWDFUND_CONSTANTS.HOP_MAX_INVITES[1]).toBe(2)
    expect(CROWDFUND_CONSTANTS.HOP_MAX_INVITES[2]).toBe(0)
  })

  it('rollover minimums are correct', () => {
    expect(CROWDFUND_CONSTANTS.HOP1_ROLLOVER_MIN).toBe(30)
    expect(CROWDFUND_CONSTANTS.HOP2_ROLLOVER_MIN).toBe(50)
  })
})
