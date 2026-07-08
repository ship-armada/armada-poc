// ABOUTME: Tests for useFees — verifies React Query integration, atom mirroring, refresh forcing, and visibility-pause for refetchInterval.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { feeQuoteAtom } from '@/state/fees'
import { tabVisibleAtom } from '@/state/visibility'
import { useFees, FEES_QUERY_KEY } from './useFees'
import * as relayer from '@/lib/relayer'

function makeQuote(expiresInMs: number): relayer.FeeSchedule {
  return {
    cacheId: `cache-${expiresInMs}-${Math.random()}`,
    expiresAt: Date.now() + expiresInMs,
    chainId: 31337,
    broadcasterRailgunAddress: '',
    fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
  }
}

function Harness({ onResult }: { onResult: (r: ReturnType<typeof useFees>) => void }) {
  const r = useFees()
  onResult(r)
  return null
}

function renderHarness(opts?: { tabVisible?: boolean; harnessCount?: number }): {
  store: ReturnType<typeof createStore>
  queryClient: QueryClient
  results: Array<ReturnType<typeof useFees>>
  unmount: () => void
} {
  const store = createStore()
  if (opts?.tabVisible !== undefined) store.set(tabVisibleAtom, opts.tabVisible)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const results: Array<ReturnType<typeof useFees>> = []
  const count = opts?.harnessCount ?? 1
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        {Array.from({ length: count }, (_, i) => (
          <Harness key={i} onResult={r => results.push(r)} />
        ))}
      </Provider>
    </QueryClientProvider>,
  )
  return { store, queryClient, results, unmount }
}

describe('useFees (React Query)', () => {
  let fetchFeesSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchFeesSpy = vi.spyOn(relayer, 'fetchFees')
  })

  afterEach(() => {
    fetchFeesSpy.mockRestore()
  })

  it('fetches on mount and mirrors the result into feeQuoteAtom', async () => {
    const quote = makeQuote(60_000)
    fetchFeesSpy.mockResolvedValue(quote)

    const { store, results } = renderHarness()

    await waitFor(() => {
      expect(results.at(-1)?.quote).toEqual(quote)
    })
    expect(store.get(feeQuoteAtom)).toEqual(quote)
    expect(fetchFeesSpy).toHaveBeenCalledTimes(1)
  })

  it('refresh() forces an immediate fetch and updates the atom', async () => {
    const first = makeQuote(60_000)
    const second = makeQuote(120_000)
    fetchFeesSpy.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    const { store, results } = renderHarness()

    await waitFor(() => expect(results.at(-1)?.quote).toEqual(first))

    let refreshed: relayer.FeeSchedule | null = null
    await act(async () => {
      refreshed = await results.at(-1)!.refresh()
    })

    expect(refreshed).toEqual(second)
    expect(store.get(feeQuoteAtom)).toEqual(second)
    expect(fetchFeesSpy).toHaveBeenCalledTimes(2)
  })

  it('three mounted instances share a single fetch (query dedup)', async () => {
    const quote = makeQuote(60_000)
    let resolveFetch!: (q: relayer.FeeSchedule) => void
    fetchFeesSpy.mockImplementation(() =>
      new Promise<relayer.FeeSchedule>(res => { resolveFetch = res }),
    )

    const { queryClient } = renderHarness({ harnessCount: 3 })

    // All three siblings subscribe to the same query key. Only ONE fetch should be in flight
    // even though useFees() was invoked three times.
    await waitFor(() => expect(fetchFeesSpy).toHaveBeenCalledTimes(1))

    await act(async () => {
      resolveFetch(quote)
    })
    await waitFor(() => expect(queryClient.getQueryData(FEES_QUERY_KEY)).toEqual(quote))
    expect(fetchFeesSpy).toHaveBeenCalledTimes(1)
  })

  it('exposes isUnavailable after repeated relayer failures and clears it on recovery (P1-28)', async () => {
    fetchFeesSpy.mockRejectedValue(new Error('relayer down'))
    const { results } = renderHarness()

    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      // useFees forces retry:true with a 5s→15s→30s cold schedule; advance enough to rack up the
      // ≥3 consecutive failures that flip isUnavailable.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(results.at(-1)?.isUnavailable).toBe(true)

      // Relayer recovers — the next successful fetch resets failureCount → isUnavailable clears.
      fetchFeesSpy.mockResolvedValue(makeQuote(60_000))
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(results.at(-1)?.isUnavailable).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // Visibility test isolates fake timers — RTL's waitFor uses real time, so we can't share fake
  // timers with the success-path tests above. This test mounts with tab hidden and verifies that
  // advancing time well past the refetch window produces no additional fetches.
  it('does not run refetchInterval while tab is hidden', async () => {
    const quote = makeQuote(60_000) // refresh window starts at 30s remaining
    fetchFeesSpy.mockResolvedValue(quote)

    const { queryClient } = renderHarness({ tabVisible: false })

    // First fetch on mount still happens (query enabled by default).
    await waitFor(() => expect(queryClient.getQueryData(FEES_QUERY_KEY)).toEqual(quote))
    expect(fetchFeesSpy).toHaveBeenCalledTimes(1)

    // Now swap to fake timers and prove no interval-driven refetch fires while hidden.
    vi.useFakeTimers({ shouldAdvanceTime: false })
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(fetchFeesSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
