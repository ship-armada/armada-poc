// ABOUTME: Tests for the useContractState hook that polls aggregate contract state via Multicall3.
// ABOUTME: Verifies initial state, successful fetch, per-call carry-forward, all-fail error, and seedCount derivation.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useContractState } from './useContractState.js'
import { aggregate3, type AggregateResult } from '../lib/multicall3.js'
import type { JsonRpcProvider } from 'ethers'

// The hook batches every read into one aggregate3 call — mock it directly so the
// test drives per-call results without touching ethers/RPC.
vi.mock('../lib/multicall3.js', async (orig) => {
  const actual = await orig<typeof import('../lib/multicall3.js')>()
  return { ...actual, aggregate3: vi.fn() }
})

const ok = (result: unknown[]): AggregateResult => ({ success: true, result: result as never })
const fail = (): AggregateResult => ({ success: false, result: undefined })

// Results in the hook's call order (15 contract reads + getCurrentBlockTimestamp).
function defaultResults(): AggregateResult[] {
  return [
    ok([0n]), // phase
    ok([false]), // armLoaded
    ok([0n]), // totalCommitted
    ok([0n, [0n, 0n, 0n]]), // getEstimatedCappedDemand
    ok([1_200_000n * 10n ** 6n]), // saleSize
    ok([0n]), // windowStart
    ok([0n]), // windowEnd
    ok([0n]), // launchTeamInviteEnd
    ok([0n]), // finalizedAt
    ok([0n]), // claimDeadline
    ok([false]), // refundMode
    ok([0n]), // getParticipantCount
    ok([0n, 0n, 0n, 0n]), // getHopStats(0)
    ok([0n, 0n, 0n, 0n]), // getHopStats(1)
    ok([0n, 0n, 0n, 0n]), // getHopStats(2)
    ok([1_700_000_000n]), // getCurrentBlockTimestamp
  ]
}

const mockProvider = {} as unknown as JsonRpcProvider
const mockAggregate3 = vi.mocked(aggregate3)

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  mockAggregate3.mockReset()
  mockAggregate3.mockResolvedValue(defaultResults())
})

describe('useContractState', () => {
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
    const r = defaultResults()
    r[1] = ok([true]) // armLoaded
    r[2] = ok([500_000n * 10n ** 6n]) // totalCommitted
    r[3] = ok([450_000n * 10n ** 6n, [280_000n * 10n ** 6n, 140_000n * 10n ** 6n, 30_000n * 10n ** 6n]])
    r[11] = ok([210n]) // participantCount
    r[12] = ok([300_000n * 10n ** 6n, 280_000n * 10n ** 6n, 100n, 42n]) // hop0
    mockAggregate3.mockResolvedValue(r)

    const { result } = renderHook(() => useContractState(mockProvider, '0x1111111111111111111111111111111111111111', 60000), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.phase).toBe(0)
    expect(result.current.armLoaded).toBe(true)
    expect(result.current.totalCommitted).toBe(500_000n * 10n ** 6n)
    expect(result.current.cappedDemand).toBe(450_000n * 10n ** 6n)
    expect(result.current.participantCount).toBe(210)
    // Seed count = hop-0 whitelistCount (4th element of getHopStats(0)).
    expect(result.current.seedCount).toBe(42)
    expect(result.current.blockTimestamp).toBe(1_700_000_000)
  })

  it('carries a single failed read forward without erroring the whole tick', async () => {
    const r = defaultResults()
    r[0] = fail() // phase read failed
    r[1] = ok([true]) // armLoaded fresh
    r[11] = ok([7n]) // participantCount fresh
    mockAggregate3.mockResolvedValue(r)

    const { result } = renderHook(() => useContractState(mockProvider, '0x1111111111111111111111111111111111111111', 60000), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.phase).toBe(0) // carried forward
    expect(result.current.armLoaded).toBe(true) // fresh
    expect(result.current.participantCount).toBe(7) // fresh
  })

  it('surfaces an error when the read burst fails entirely', async () => {
    mockAggregate3.mockRejectedValue(new Error('RPC connection failed'))

    const { result } = renderHook(() => useContractState(mockProvider, '0x1111111111111111111111111111111111111111', 60000), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.error).toBe('RPC connection failed'))
    expect(result.current.loading).toBe(false)
  })

  it('throws (surfaces error) when every sub-call fails', async () => {
    mockAggregate3.mockResolvedValue(defaultResults().map(() => fail()))

    const { result } = renderHook(() => useContractState(mockProvider, '0x1111111111111111111111111111111111111111', 60000), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.error).toBe('All contract reads failed'))
  })

  it('derives seedCount from hop-0 whitelistCount', async () => {
    const r = defaultResults()
    r[12] = ok([0n, 0n, 0n, 137n]) // hop0 whitelistCount
    mockAggregate3.mockResolvedValue(r)

    const { result } = renderHook(() => useContractState(mockProvider, '0x1111111111111111111111111111111111111111', 60000), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.seedCount).toBe(137)
  })
})
