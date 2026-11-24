// ABOUTME: Tests for useRefundOnlyClaim: when it reads, what it returns, and that a wallet switch re-reads.
// ABOUTME: Mocks the address config, provider factory and contract reads; no chain is involved.
// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'

const { mockRead, mockAddress } = vi.hoisted(() => ({
  mockRead: vi.fn(),
  mockAddress: { value: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as string | null },
}))

vi.mock('@/config/refundOnly', () => ({ getRefundOnlyCrowdfundAddress: () => mockAddress.value }))
vi.mock('@/lib/refundOnlyClaim', () => ({
  readRefundOnlyClaim: mockRead,
  refundOnlyContract: () => ({}),
}))
vi.mock('@armada/crowdfund-shared', () => ({ createProvider: () => ({ isProvider: true }) }))
vi.mock('@/config/network', () => ({ getHubRpcUrls: () => ['http://localhost:8545'] }))

import { useRefundOnlyClaim } from './useRefundOnlyClaim'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

describe('useRefundOnlyClaim', () => {
  beforeEach(() => {
    onlineManager.setOnline(true)
    mockRead.mockReset()
    mockAddress.value = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
  })

  // WHY: nothing to read until a wallet is connected; no request, no state.
  it('does not read without a wallet', () => {
    const { result } = renderHook(() => useRefundOnlyClaim(null), { wrapper })
    expect(mockRead).not.toHaveBeenCalled()
    expect(result.current.state).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  // WHY: with the feature off (no first sale on this network) the hook must stay inert.
  it('does nothing when the feature is off', () => {
    mockAddress.value = null
    const { result } = renderHook(() => useRefundOnlyClaim(A), { wrapper })
    expect(mockRead).not.toHaveBeenCalled()
    expect(result.current.crowdfundAddress).toBeNull()
    expect(result.current.provider).toBeNull()
    expect(result.current.state).toBeNull()
  })

  it('returns the read state for the connected wallet', async () => {
    mockRead.mockResolvedValue({ kind: 'eligible', amount: 5n })
    const { result } = renderHook(() => useRefundOnlyClaim(A), { wrapper })
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'eligible', amount: 5n }))
    expect(mockRead).toHaveBeenCalledWith(expect.anything(), A)
  })

  // WHY: an account switch must never show the previous wallet's refund.
  it('re-reads for a different wallet', async () => {
    mockRead.mockImplementation(async (_r: unknown, w: string) =>
      w === A ? { kind: 'eligible', amount: 5n } : { kind: 'none' },
    )
    const { result, rerender } = renderHook(({ w }) => useRefundOnlyClaim(w), {
      wrapper,
      initialProps: { w: A },
    })
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'eligible', amount: 5n }))
    rerender({ w: B })
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'none' }))
  })
})
