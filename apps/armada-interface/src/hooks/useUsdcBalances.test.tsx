// ABOUTME: Tests for useUsdcBalances — verifies per-chain queries are skipped while disconnected, atom is mirrored on success, visibility-pause halts the interval, atom is cleared on disconnect.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { usdcBalancesAtom } from '@/state/wallet'
import { tabVisibleAtom } from '@/state/visibility'

vi.mock('wagmi/actions', () => ({
  readContract: vi.fn(),
}))

vi.mock('@/config/deployments', () => ({
  loadDeployments: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: vi.fn(),
}))

import { useUsdcBalances, mergeUsdcBalances } from './useUsdcBalances'
import { readContract } from 'wagmi/actions'
import { loadDeployments } from '@/config/deployments'
import { useWallet } from '@/hooks/useWallet'

const mockReadContract = readContract as unknown as ReturnType<typeof vi.fn>
const mockLoadDeployments = loadDeployments as unknown as ReturnType<typeof vi.fn>
const mockUseWallet = useWallet as unknown as ReturnType<typeof vi.fn>

const HUB_USDC = '0x0000000000000000000000000000000000000hub' as `0x${string}`
const CLIENT_A_USDC = '0x0000000000000000000000000000000000000aaa' as `0x${string}`
const CLIENT_B_USDC = '0x0000000000000000000000000000000000000bbb' as `0x${string}`
const TEST_ADDR = '0x1234567890abcdef1234567890abcdef12345678'

const DEPLOYMENTS = {
  hub: { chainId: 31337, cctp: { usdc: HUB_USDC } },
  clients: [
    { chainId: 31338, cctp: { usdc: CLIENT_A_USDC } },
    { chainId: 31339, cctp: { usdc: CLIENT_B_USDC } },
  ],
}

function Harness() {
  useUsdcBalances()
  return null
}

function renderHarness(opts?: { tabVisible?: boolean }): {
  store: ReturnType<typeof createStore>
  queryClient: QueryClient
} {
  const store = createStore()
  if (opts?.tabVisible !== undefined) store.set(tabVisibleAtom, opts.tabVisible)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <Harness />
      </Provider>
    </QueryClientProvider>,
  )
  return { store, queryClient }
}

describe('useUsdcBalances', () => {
  beforeEach(() => {
    mockLoadDeployments.mockResolvedValue(DEPLOYMENTS)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not query any chain while the wallet is disconnected', async () => {
    mockUseWallet.mockReturnValue({ address: null })

    renderHarness()
    // Let microtasks run so the deployments query resolves.
    await act(async () => { await Promise.resolve() })

    expect(mockReadContract).not.toHaveBeenCalled()
  })

  it('mirrors per-chain balances into usdcBalancesAtom after the wallet connects', async () => {
    mockUseWallet.mockReturnValue({ address: TEST_ADDR })
    mockReadContract.mockImplementation(async (_cfg, args: { chainId: number }) => {
      if (args.chainId === 31337) return 1_000_000n
      if (args.chainId === 31338) return 2_000_000n
      if (args.chainId === 31339) return 3_000_000n
      throw new Error(`unexpected chainId ${args.chainId}`)
    })

    const { store } = renderHarness()

    await waitFor(() => {
      const balances = store.get(usdcBalancesAtom)
      expect(balances[31337]).toBe(1_000_000n)
      expect(balances[31338]).toBe(2_000_000n)
      expect(balances[31339]).toBe(3_000_000n)
    })
  })

  it('clears the atom when the wallet disconnects', async () => {
    mockUseWallet.mockReturnValue({ address: TEST_ADDR })
    mockReadContract.mockResolvedValue(1_000_000n)

    const { store } = renderHarness()

    await waitFor(() => expect(store.get(usdcBalancesAtom)[31337]).toBe(1_000_000n))

    // Now simulate disconnect: re-render the Harness with no address.
    mockUseWallet.mockReturnValue({ address: null })
    const queryClient2 = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient2}>
        <Provider store={store}>
          <Harness />
        </Provider>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(store.get(usdcBalancesAtom)).toEqual({}))
  })

  it('retries a flaky deployments load so balances still populate (P2/WS3.4)', async () => {
    // Without retry, a single manifest-fetch hiccup leaves `pairs` empty (blank balances) until a
    // window refocus. The query's retry (1s backoff) self-heals it.
    mockUseWallet.mockReturnValue({ address: TEST_ADDR })
    mockReadContract.mockResolvedValue(1_000_000n)
    mockLoadDeployments.mockReset()
    mockLoadDeployments
      .mockRejectedValueOnce(new Error('manifest fetch failed'))
      .mockResolvedValue(DEPLOYMENTS)

    const { store } = renderHarness()

    // First attempt fails; the retry (~1s) succeeds and balances land. Real timers + a longer
    // waitFor budget than the 1s backoff.
    await waitFor(
      () => expect(store.get(usdcBalancesAtom)[31337]).toBe(1_000_000n),
      { timeout: 5_000 },
    )
    expect(mockLoadDeployments.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('does not refetch on the interval while tab is hidden', async () => {
    mockUseWallet.mockReturnValue({ address: TEST_ADDR })
    mockReadContract.mockResolvedValue(1_000_000n)

    const { store } = renderHarness({ tabVisible: false })

    await waitFor(() => expect(store.get(usdcBalancesAtom)[31337]).toBe(1_000_000n))
    const callsAfterFirst = mockReadContract.mock.calls.length

    vi.useFakeTimers({ shouldAdvanceTime: false })
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(mockReadContract.mock.calls.length).toBe(callsAfterFirst)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mergeUsdcBalances', () => {
  it('returns the SAME reference when no balance changed (steady-state poll → no re-render)', () => {
    // WHY: React Query hands back a fresh `results` array on every poll tick even when the on-chain
    // balances are unchanged. Without this bail-out the mirror effect wrote a new object each tick,
    // notifying every usdcBalancesAtom subscriber (the MAX button, etc.) for nothing.
    const prev = { 31337: 1_000_000n, 31338: 2_000_000n }
    const results = [
      { data: { chainId: 31337, balance: 1_000_000n } },
      { data: { chainId: 31338, balance: 2_000_000n } },
    ]
    expect(mergeUsdcBalances(prev, results)).toBe(prev)
  })

  it('returns a new map with merged values when a balance changed', () => {
    const prev = { 31337: 1_000_000n }
    const results = [{ data: { chainId: 31337, balance: 1_500_000n } }]
    const next = mergeUsdcBalances(prev, results)
    expect(next).not.toBe(prev)
    expect(next[31337]).toBe(1_500_000n)
  })

  it('adds a chain that was not present before', () => {
    const prev = { 31337: 1_000_000n }
    const results = [{ data: { chainId: 31338, balance: 7n } }]
    const next = mergeUsdcBalances(prev, results)
    expect(next).not.toBe(prev)
    expect(next[31338]).toBe(7n)
    expect(next[31337]).toBe(1_000_000n)
  })

  it('ignores unfulfilled (no data) entries and keeps the prior reference', () => {
    const prev = { 31337: 1_000_000n }
    const results = [{ data: undefined }, { data: { chainId: 31337, balance: 1_000_000n } }]
    expect(mergeUsdcBalances(prev, results)).toBe(prev)
  })
})
