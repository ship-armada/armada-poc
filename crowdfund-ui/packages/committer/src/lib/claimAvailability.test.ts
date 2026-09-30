// ABOUTME: Tests for the committer's claim-page gate and the pre-finalize refund projection.
// ABOUTME: Refund is projected from the post-waterfall allocation, mirroring ArmadaCrowdfund.finalize().

import { describe, it, expect } from 'vitest'
import { getClaimAvailability, isProjectedRefund } from './claimAvailability'

const USDC = (n: number) => BigInt(n) * 1_000_000n

const WINDOW_END = 1_000
const AFTER_WINDOW = WINDOW_END + 1
const DURING_WINDOW = WINDOW_END - 1

function hops(h0: number, h1: number, h2: number) {
  return [
    { cappedCommitted: USDC(h0) },
    { cappedCommitted: USDC(h1) },
    { cappedCommitted: USDC(h2) },
  ]
}

function projected(
  phase: number,
  blockTimestamp: number,
  hopStats: { cappedCommitted: bigint }[],
): boolean {
  const cappedDemand = hopStats.reduce((sum, h) => sum + h.cappedCommitted, 0n)
  return isProjectedRefund({ phase, windowEnd: WINDOW_END, blockTimestamp, hopStats, cappedDemand })
}

describe('isProjectedRefund', () => {
  // WHY: $1.5M of capped demand concentrated in hop-0 clears both MIN_SALE and the
  // expansion trigger, yet hop-0's 47% ceiling at MAX_SALE allocates only $846k, so
  // finalize() will refund. A capped-demand check would wrongly call this a success.
  it('projects a refund when concentrated hop-0 demand allocates below MIN_SALE', () => {
    expect(projected(0, AFTER_WINDOW, hops(1_500_000, 0, 0))).toBe(true)
  })

  // WHY: capped demand below MIN_SALE always refunds — the allocation can never exceed it.
  it('projects a refund when capped demand is below MIN_SALE', () => {
    expect(projected(0, AFTER_WINDOW, hops(500_000, 0, 0))).toBe(true)
  })

  // WHY: demand spread across hops allocates $564k + $450k = $1.014M ≥ MIN_SALE,
  // so finalize() succeeds and no refund heads-up should be shown.
  it('does not project a refund when the waterfall allocates at least MIN_SALE', () => {
    expect(projected(0, AFTER_WINDOW, hops(564_000, 450_000, 0))).toBe(false)
  })

  // WHY: while the window is open, demand can still change — the outcome is not yet determined.
  it('does not project a refund while the commit window is open', () => {
    expect(projected(0, DURING_WINDOW, hops(500_000, 0, 0))).toBe(false)
  })

  // WHY: after finalize() the contract's refundMode flag is authoritative; no projection.
  it('does not project once the sale is finalized or cancelled', () => {
    expect(projected(1, AFTER_WINDOW, hops(500_000, 0, 0))).toBe(false)
    expect(projected(2, AFTER_WINDOW, hops(500_000, 0, 0))).toBe(false)
  })
})

describe('getClaimAvailability', () => {
  it('is pre-open before ARM is loaded', () => {
    expect(getClaimAvailability(0, false, WINDOW_END, DURING_WINDOW, false)).toEqual({ state: 'pre-open' })
  })

  it('is available once finalized or cancelled', () => {
    expect(getClaimAvailability(1, true, WINDOW_END, AFTER_WINDOW, false)).toEqual({ state: 'available' })
    expect(getClaimAvailability(2, true, WINDOW_END, AFTER_WINDOW, false)).toEqual({ state: 'available' })
  })

  // WHY: a projected refund opens the Claim page before finalize() so ClaimFlowV2 can
  // render its "Sale ended below minimum" heads-up instead of the generic gate.
  it('is available after the window when a refund is projected', () => {
    expect(getClaimAvailability(0, true, WINDOW_END, AFTER_WINDOW, true)).toEqual({ state: 'available' })
  })

  it('awaits finalization after the window when no refund is projected', () => {
    expect(getClaimAvailability(0, true, WINDOW_END, AFTER_WINDOW, false)).toEqual({
      state: 'pending',
      reason: 'Awaiting finalization',
    })
  })

  it('is pending while the commit window is open', () => {
    expect(getClaimAvailability(0, true, WINDOW_END, DURING_WINDOW, false)).toEqual({
      state: 'pending',
      reason: 'Opens after the campaign window ends',
    })
  })
})
