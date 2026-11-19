// ABOUTME: Tests for useMaxWindowDuration — the one-off MAX_WINDOW_DURATION read.
// ABOUTME: Verifies seconds on success and null (feature absent) when the contract lacks the getter.

import { renderHook, waitFor } from '@testing-library/react'
import type { JsonRpcProvider } from 'ethers'
import { useMaxWindowDuration } from './useMaxWindowDuration'

// A plain function rather than vi.fn(): a vi.fn() that returns a rejected promise was reported as a
// failure in this or the next test even though the hook catches it.
let maxWindowDurationImpl: () => Promise<bigint> = async () => 0n
let maxWindowDurationCalls = 0
const mockMaxWindowDuration = () => {
  maxWindowDurationCalls++
  return maxWindowDurationImpl()
}

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: class MockContract {
      constructor() {
        return { MAX_WINDOW_DURATION: mockMaxWindowDuration }
      }
    },
  }
})

const provider = {} as JsonRpcProvider

describe('useMaxWindowDuration', () => {
  beforeEach(() => { maxWindowDurationCalls = 0 })

  it('returns the maximum window in seconds', async () => {
    maxWindowDurationImpl = async () => 1_209_600n
    const { result } = renderHook(() => useMaxWindowDuration(provider, '0xcf'))
    await waitFor(() => expect(result.current).toBe(1_209_600))
  })

  // WHY: the canceled Launch 1 crowdfund predates extendWindow and reverts on this getter. The
  // admin app still serves it (refunds, ARM sweep), so the failure must mean "no extension",
  // not an error that breaks the page.
  it('returns null when the contract has no MAX_WINDOW_DURATION', async () => {
    maxWindowDurationImpl = () => Promise.reject(new Error('execution reverted'))
    const { result } = renderHook(() => useMaxWindowDuration(provider, '0xcf'))
    await waitFor(() => expect(result.current).toBeNull())
  })

  it('stays undefined without a provider or address', () => {
    const { result } = renderHook(() => useMaxWindowDuration(null, '0xcf'))
    expect(result.current).toBeUndefined()
    expect(maxWindowDurationCalls).toBe(0)
  })
})
