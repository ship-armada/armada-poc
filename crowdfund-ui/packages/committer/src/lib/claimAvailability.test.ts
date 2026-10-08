// ABOUTME: Unit tests for the claim-page gate and the pre-finalize refund projection.
// ABOUTME: Refund is projected from post-waterfall allocation, matching ArmadaCrowdfund.finalize().
import { describe, it, expect } from 'vitest'
import { getClaimAvailability, isProjectedRefund } from './claimAvailability'

const WINDOW_END = 1_750_000_000
const K = 1_000n * 10n ** 6n

/** Pre-finalize sale state with per-hop capped demand in thousands of USDC. */
function saleState(hop0: bigint, hop1: bigint, hop2: bigint, overrides: { phase?: number; blockTimestamp?: number } = {}) {
  return {
    phase: overrides.phase ?? 0,
    windowEnd: WINDOW_END,
    blockTimestamp: overrides.blockTimestamp ?? WINDOW_END + 1,
    hopStats: [{ cappedCommitted: hop0 * K }, { cappedCommitted: hop1 * K }, { cappedCommitted: hop2 * K }],
    cappedDemand: (hop0 + hop1 + hop2) * K,
  }
}

describe('isProjectedRefund', () => {
  it('is true after the window when capped demand is below MIN_SALE', () => {
    expect(isProjectedRefund(saleState(500n, 200n, 100n))).toBe(true)
  })

  it('is true after the window when hop-0-heavy demand clears MIN_SALE but allocates below it', () => {
    // WHY: finalize() refunds on allocation, not capped demand. $1.05M capped with
    // $900k at hop-0 allocates $714k, so the sale refunds despite clearing $1M.
    expect(isProjectedRefund(saleState(900n, 100n, 50n))).toBe(true)
  })

  it('is false after the window when spread demand allocates at least MIN_SALE', () => {
    expect(isProjectedRefund(saleState(564n, 300n, 200n))).toBe(false)
  })

  it('is false while the window is still open — demand can still change', () => {
    expect(isProjectedRefund(saleState(500n, 0n, 0n, { blockTimestamp: WINDOW_END }))).toBe(false)
  })

  it('is false once the sale is finalized or cancelled — the contract flag is authoritative', () => {
    expect(isProjectedRefund(saleState(500n, 0n, 0n, { phase: 1 }))).toBe(false)
    expect(isProjectedRefund(saleState(500n, 0n, 0n, { phase: 2 }))).toBe(false)
  })
})

describe('getClaimAvailability', () => {
  it('is pre-open before ARM is loaded', () => {
    expect(getClaimAvailability(0, false, WINDOW_END, WINDOW_END - 10, false)).toEqual({ state: 'pre-open' })
  })

  it('is available once finalized or cancelled', () => {
    expect(getClaimAvailability(1, true, WINDOW_END, WINDOW_END + 1, false)).toEqual({ state: 'available' })
    expect(getClaimAvailability(2, true, WINDOW_END, WINDOW_END + 1, false)).toEqual({ state: 'available' })
  })

  it('is available after the window when a refund is projected', () => {
    expect(getClaimAvailability(0, true, WINDOW_END, WINDOW_END + 1, true)).toEqual({ state: 'available' })
  })

  it('awaits finalization after the window when no refund is projected', () => {
    expect(getClaimAvailability(0, true, WINDOW_END, WINDOW_END + 1, false)).toEqual({
      state: 'pending',
      reason: 'Awaiting finalization',
    })
  })

  it('is pending while the window is open', () => {
    expect(getClaimAvailability(0, true, WINDOW_END, WINDOW_END - 10, false)).toEqual({
      state: 'pending',
      reason: 'Opens after the campaign window ends',
    })
  })
})
