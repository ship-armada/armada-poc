// ABOUTME: Tests for useDebouncedValue — value only updates after the input is stable for delayMs.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebouncedValue } from './useDebouncedValue'

afterEach(() => {
  vi.useRealTimers()
})

describe('useDebouncedValue', () => {
  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue(5n, 400))
    expect(result.current).toBe(5n)
  })

  it('only updates after the input has been stable for delayMs', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 400), {
      initialProps: { v: 1n },
    })
    expect(result.current).toBe(1n)

    // Rapid changes within the window — debounced value does not move.
    rerender({ v: 2n })
    rerender({ v: 3n })
    act(() => {
      vi.advanceTimersByTime(399)
    })
    expect(result.current).toBe(1n)

    // Once the window elapses with no further change, it settles on the latest value.
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(3n)
  })
})
