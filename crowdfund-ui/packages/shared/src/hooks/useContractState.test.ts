// ABOUTME: Tests for the useContractState hook that polls aggregate contract state.
// ABOUTME: Verifies initial state, successful fetch, error handling, and polling lifecycle.

// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useContractState } from './useContractState.js'
import type { JsonRpcProvider } from 'ethers'

// Mock ethers Contract to avoid real RPC calls
const mockContract = {
  phase: vi.fn().mockResolvedValue(0n),
  armLoaded: vi.fn().mockResolvedValue(false),
  totalCommitted: vi.fn().mockResolvedValue(0n),
  getEstimatedCappedDemand: vi.fn().mockResolvedValue([0n, [0n, 0n, 0n]]),
  saleSize: vi.fn().mockResolvedValue(1_200_000n * 10n ** 6n),
  windowStart: vi.fn().mockResolvedValue(0n),
  windowEnd: vi.fn().mockResolvedValue(0n),
  launchTeamInviteEnd: vi.fn().mockResolvedValue(0n),
  finalizedAt: vi.fn().mockResolvedValue(0n),
  claimDeadline: vi.fn().mockResolvedValue(0n),
  refundMode: vi.fn().mockResolvedValue(false),
  getParticipantCount: vi.fn().mockResolvedValue(0n),
  getHopStats: vi.fn().mockResolvedValue([0n, 0n, 0n, 0n]),
}

vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers')
  return {
    ...actual,
    Contract: class MockContract {
      constructor() {
        return mockContract
      }
    },
  }
})

const mockProvider = {
  getBlock: vi.fn().mockResolvedValue({ timestamp: 1700000000 }),
} as unknown as JsonRpcProvider

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

describe('useContractState', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // Reset all mocks to their default implementations
    mockContract.phase.mockReset().mockResolvedValue(0n)
    mockContract.armLoaded.mockReset().mockResolvedValue(false)
    mockContract.totalCommitted.mockReset().mockResolvedValue(0n)
    mockContract.getEstimatedCappedDemand.mockReset().mockResolvedValue([0n, [0n, 0n, 0n]])
    mockContract.saleSize.mockReset().mockResolvedValue(1_200_000n * 10n ** 6n)
    mockContract.windowStart.mockReset().mockResolvedValue(0n)
    mockContract.windowEnd.mockReset().mockResolvedValue(0n)
    mockContract.launchTeamInviteEnd.mockReset().mockResolvedValue(0n)
    mockContract.finalizedAt.mockReset().mockResolvedValue(0n)
    mockContract.claimDeadline.mockReset().mockResolvedValue(0n)
    mockContract.refundMode.mockReset().mockResolvedValue(false)
    mockContract.getParticipantCount.mockReset().mockResolvedValue(0n)
    mockContract.getHopStats.mockReset().mockResolvedValue([0n, 0n, 0n, 0n])
    ;(mockProvider as any).getBlock.mockReset().mockResolvedValue({ timestamp: 1700000000 })
  })

  it('returns initial loading state with null provider', () => {
    const { result } = renderHook(() => useContractState(null, null, 5000), {
      wrapper: makeWrapper(),
    })

    expect(result.current.loading).toBe(true)
    expect(result.current.phase).toBe(0)
    expect(result.current.totalCommitted).toBe(0n)
    expect(result.current.error).toBeNull()
  })

  it('fetches contract state and transitions from loading', async () => {
    mockContract.phase.mockResolvedValue(0n)
    mockContract.armLoaded.mockResolvedValue(true)
    mockContract.totalCommitted.mockResolvedValue(500_000n * 10n ** 6n)
    mockContract.getEstimatedCappedDemand.mockResolvedValue([450_000n * 10n ** 6n, [280_000n * 10n ** 6n, 140_000n * 10n ** 6n, 30_000n * 10n ** 6n]])
    mockContract.getHopStats.mockImplementation((hop: number) => {
      if (hop === 0) return Promise.resolve([300_000n * 10n ** 6n, 280_000n * 10n ** 6n, 100n, 42n])
      if (hop === 1) return Promise.resolve([150_000n * 10n ** 6n, 140_000n * 10n ** 6n, 80n, 200n])
      return Promise.resolve([50_000n * 10n ** 6n, 30_000n * 10n ** 6n, 30n, 500n])
    })
    mockContract.getParticipantCount.mockResolvedValue(210n)

    const { result } = renderHook(
      () => useContractState(mockProvider, '0xcontract', 60000),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.phase).toBe(0)
    expect(result.current.armLoaded).toBe(true)
    expect(result.current.totalCommitted).toBe(500_000n * 10n ** 6n)
    expect(result.current.cappedDemand).toBe(450_000n * 10n ** 6n)
    expect(result.current.participantCount).toBe(210)
    // Seed count = hop-0 whitelistCount (4th element of getHopStats(0))
    expect(result.current.seedCount).toBe(42)
    expect(result.current.blockTimestamp).toBe(1700000000)
  })

  it('handles errors gracefully', async () => {
    mockContract.phase.mockRejectedValue(new Error('RPC connection failed'))

    const { result } = renderHook(
      () => useContractState(mockProvider, '0xcontract', 60000),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => {
      expect(result.current.error).toBe('RPC connection failed')
    })

    expect(result.current.loading).toBe(false)
  })

  it('derives seedCount from hop-0 whitelistCount', async () => {
    mockContract.getHopStats.mockImplementation((hop: number) => {
      if (hop === 0) return Promise.resolve([0n, 0n, 0n, 137n])
      return Promise.resolve([0n, 0n, 0n, 0n])
    })

    const { result } = renderHook(
      () => useContractState(mockProvider, '0xcontract', 60000),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.seedCount).toBe(137)
  })
})
