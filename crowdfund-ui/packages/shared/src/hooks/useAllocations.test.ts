// ABOUTME: Tests for the useAllocations hook that prefetches computeAllocation() results.
// ABOUTME: Verifies activation conditions, batching, and merge-with-event-data behavior.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useAllocations } from './useAllocations.js'
import type { AddressSummary } from '../lib/graph.js'

// Mock ethers Contract — must return a proper constructor
const mockComputeAllocation = vi.fn()

vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers')
  return {
    ...actual,
    Contract: class MockContract {
      computeAllocation = mockComputeAllocation
    },
  }
})

function makeSummary(
  address: string,
  overrides: Partial<AddressSummary> = {},
): AddressSummary {
  return {
    address,
    hops: [0],
    totalCommitted: 1000_000000n,
    perHop: new Map([[0, 1000_000000n]]),
    displayInviter: 'armada',
    allocatedArm: null,
    refundUsdc: null,
    allocatedPerHop: new Map(),
    armClaimed: false,
    refundClaimed: false,
    delegate: null,
    ...overrides,
  }
}

describe('useAllocations', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mockComputeAllocation.mockReset()
  })

  it('returns empty map when phase !== 1', () => {
    const summaries = new Map([['0xabc', makeSummary('0xabc')]])
    const { result } = renderHook(() =>
      useAllocations({
        provider: {} as any,
        contractAddress: '0xcontract',
        phase: 0,
        refundMode: false,
        summaries,
      }),
    )
    expect(result.current.size).toBe(0)
  })

  it('returns empty map in refund mode', () => {
    const summaries = new Map([['0xabc', makeSummary('0xabc')]])
    const { result } = renderHook(() =>
      useAllocations({
        provider: {} as any,
        contractAddress: '0xcontract',
        phase: 1,
        refundMode: true,
        summaries,
      }),
    )
    expect(result.current.size).toBe(0)
  })

  it('skips addresses that already have allocation from events', async () => {
    const summaries = new Map([
      ['0xclaimed', makeSummary('0xclaimed', { allocatedArm: 500n })],
      ['0xunclaimed', makeSummary('0xunclaimed')],
    ])

    mockComputeAllocation.mockResolvedValue([1000_000000000000000000n, 100_000000n])

    const { result } = renderHook(() =>
      useAllocations({
        provider: { _isProvider: true } as any,
        contractAddress: '0xcontract',
        phase: 1,
        refundMode: false,
        summaries,
      }),
    )

    await waitFor(() => {
      expect(result.current.size).toBe(1)
    })

    // Only the unclaimed address should have been queried
    expect(mockComputeAllocation).toHaveBeenCalledTimes(1)
    expect(mockComputeAllocation).toHaveBeenCalledWith('0xunclaimed')
    expect(result.current.has('0xunclaimed')).toBe(true)
    expect(result.current.has('0xclaimed')).toBe(false)
  })

  it('returns empty map when provider is null', () => {
    const summaries = new Map([['0xabc', makeSummary('0xabc')]])
    const { result } = renderHook(() =>
      useAllocations({
        provider: null,
        contractAddress: '0xcontract',
        phase: 1,
        refundMode: false,
        summaries,
      }),
    )
    expect(result.current.size).toBe(0)
  })
})
