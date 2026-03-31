// ABOUTME: Tests for useProRataEstimate hook — pro-rata allocation math.
// ABOUTME: Covers under-subscribed, oversubscribed, hop-2 residual, and zero-demand cases.

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useProRataEstimate } from './useProRataEstimate'
import type { HopStatsData } from '@armada/crowdfund-shared'

const USDC = 10n ** 6n
const ARM_SCALE = 10n ** 12n // 6-dec USDC → 18-dec ARM

const SALE_SIZE = 1_200_000n * USDC // 1.2M base sale

function makeHopStats(overrides: Partial<HopStatsData>[] = []): HopStatsData[] {
  const defaults: HopStatsData[] = [
    { totalCommitted: 0n, cappedCommitted: 0n, uniqueCommitters: 0, whitelistCount: 0 },
    { totalCommitted: 0n, cappedCommitted: 0n, uniqueCommitters: 0, whitelistCount: 0 },
    { totalCommitted: 0n, cappedCommitted: 0n, uniqueCommitters: 0, whitelistCount: 0 },
  ]
  for (let i = 0; i < overrides.length; i++) {
    defaults[i] = { ...defaults[i], ...overrides[i] }
  }
  return defaults
}

describe('useProRataEstimate', () => {
  it('returns empty estimates for empty commit amounts', () => {
    const { result } = renderHook(() =>
      useProRataEstimate(new Map(), makeHopStats(), SALE_SIZE),
    )
    expect(result.current.hopEstimates).toHaveLength(0)
    expect(result.current.totalEstimatedArm).toBe(0n)
    expect(result.current.totalEstimatedRefund).toBe(0n)
  })

  it('returns full allocation when under-subscribed at hop-0', () => {
    const commitAmounts = new Map([[0, 10_000n * USDC]])
    // Hop-0 ceiling: 70% of 1.2M = 840,000 USDC. Current demand: 0. Our commit: 10,000.
    const { result } = renderHook(() =>
      useProRataEstimate(commitAmounts, makeHopStats(), SALE_SIZE),
    )
    expect(result.current.hopEstimates).toHaveLength(1)
    const est = result.current.hopEstimates[0]
    expect(est.estimatedAccepted).toBe(10_000n * USDC) // full allocation
    expect(est.estimatedRefund).toBe(0n)
    expect(est.estimatedArm).toBe(10_000n * USDC * ARM_SCALE)
    expect(est.oversubscriptionPct).toBeLessThan(100)
  })

  it('applies pro-rata when oversubscribed at hop-0', () => {
    const commitAmounts = new Map([[0, 100_000n * USDC]])
    // Hop-0 ceiling: 840,000. Existing demand: 800,000. Adding 100,000 → total 900,000 > 840,000
    const stats = makeHopStats([{ cappedCommitted: 800_000n * USDC }])
    const { result } = renderHook(() =>
      useProRataEstimate(commitAmounts, stats, SALE_SIZE),
    )
    const est = result.current.hopEstimates[0]
    // Pro-rata: 100,000 * 840,000 / 900,000 ≈ 93,333
    expect(est.estimatedAccepted).toBeLessThan(100_000n * USDC)
    expect(est.estimatedAccepted).toBeGreaterThan(0n)
    expect(est.estimatedRefund).toBeGreaterThan(0n)
    expect(est.oversubscriptionPct).toBeGreaterThan(100)
  })

  it('calculates hop-2 residual allocation', () => {
    const commitAmounts = new Map([[2, 500n * USDC]])
    // Hop-0 capped at 500k, hop-1 capped at 300k, residual = 1.2M - 500k - 300k = 400k
    const stats = makeHopStats([
      { cappedCommitted: 500_000n * USDC },
      { cappedCommitted: 300_000n * USDC },
      { cappedCommitted: 0n },
    ])
    const { result } = renderHook(() =>
      useProRataEstimate(commitAmounts, stats, SALE_SIZE),
    )
    const est = result.current.hopEstimates[0]
    // Hop-2 allocation = 1.2M - 500k - 300k = 400k. Demand = 500. Under-subscribed.
    expect(est.estimatedAccepted).toBe(500n * USDC)
  })

  it('handles multi-hop commits', () => {
    const commitAmounts = new Map([
      [0, 10_000n * USDC],
      [1, 3_000n * USDC],
    ])
    const { result } = renderHook(() =>
      useProRataEstimate(commitAmounts, makeHopStats(), SALE_SIZE),
    )
    expect(result.current.hopEstimates).toHaveLength(2)
    expect(result.current.totalEstimatedArm).toBe(
      result.current.hopEstimates[0].estimatedArm + result.current.hopEstimates[1].estimatedArm,
    )
  })

  it('skips zero or negative amounts', () => {
    const commitAmounts = new Map([[0, 0n]])
    const { result } = renderHook(() =>
      useProRataEstimate(commitAmounts, makeHopStats(), SALE_SIZE),
    )
    expect(result.current.hopEstimates).toHaveLength(0)
  })
})
