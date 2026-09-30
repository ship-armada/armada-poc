// ABOUTME: Tests for TableView's oversubscribed-hop detection used to badge pro-rated hops.
// ABOUTME: Ceilings must match the contract waterfall (47% / rollover-boosted / 15% floor), not raw BPS.

import { describe, it, expect } from 'vitest'
import { getOversubscribedHops } from './TableView'
import type { HopStatsData } from './StatsBar'

const USDC = (n: number) => BigInt(n) * 1_000_000n
const BASE_SALE = USDC(1_200_000)

function hops(h0: number, h1: number, h2: number): HopStatsData[] {
  return [h0, h1, h2].map((c) => ({
    totalCommitted: USDC(c),
    cappedCommitted: USDC(c),
    whitelistCount: 0,
    uniqueCommitters: 0,
  }))
}

describe('getOversubscribedHops', () => {
  it('returns nothing before finalization (saleSize 0)', () => {
    expect(getOversubscribedHops(hops(900_000, 0, 0), 0n).size).toBe(0)
  })

  // WHY: at BASE_SALE hop-0's effective ceiling is $564k (60% of the 95% base pool,
  // less the 10% extra hop-2 floor). $600k is pro-rated even though it is below the
  // $720k a naive saleSize × ceilingBps would give.
  it('flags hop-0 above its effective 47% ceiling', () => {
    expect([...getOversubscribedHops(hops(600_000, 0, 0), BASE_SALE)]).toEqual([0])
  })

  // WHY: hop-2 has no BPS ceiling but is still capped at floor + rollover. With hop-0
  // and hop-1 absorbing their whole shares, hop-2's ceiling is the $180k floor.
  it('flags hop-1 and hop-2 when the waterfall leaves them no rollover', () => {
    expect([...getOversubscribedHops(hops(600_000, 500_000, 200_000), BASE_SALE)].sort()).toEqual([0, 1, 2])
  })

  it('flags nothing when every hop fits under its waterfall ceiling', () => {
    expect(getOversubscribedHops(hops(500_000, 300_000, 100_000), BASE_SALE).size).toBe(0)
  })
})
