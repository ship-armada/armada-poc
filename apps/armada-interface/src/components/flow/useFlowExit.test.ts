// ABOUTME: Tests for useFlowExit — the flow-modal close that plays the slide-down before running onClose.
// ABOUTME: Covers the reduced-motion synchronous path, the motion-enabled deferred path, and re-entry guarding.

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFlowExit } from './useFlowExit'

/** Run `fn` with non-reduced motion reported (test setup defaults to reduced). */
function withMotionEnabled(fn: () => void) {
  const original = window.matchMedia
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia
  try {
    fn()
  } finally {
    window.matchMedia = original
  }
}

describe('useFlowExit', () => {
  it('closes synchronously under reduced motion (nothing to animate)', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useFlowExit(onClose))
    act(() => result.current.requestClose())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(result.current.exiting).toBe(false)
  })

  it('plays the exit, then closes after the animation window (motion enabled)', () => {
    vi.useFakeTimers()
    try {
      withMotionEnabled(() => {
        const onClose = vi.fn()
        const { result } = renderHook(() => useFlowExit(onClose))
        act(() => result.current.requestClose())
        // Mid-animation: exiting is flagged, the real close hasn't run yet.
        expect(result.current.exiting).toBe(true)
        expect(onClose).not.toHaveBeenCalled()
        act(() => {
          vi.runAllTimers()
        })
        expect(onClose).toHaveBeenCalledTimes(1)
        expect(result.current.exiting).toBe(false)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores re-entrant close requests while the exit is already running', () => {
    vi.useFakeTimers()
    try {
      withMotionEnabled(() => {
        const onClose = vi.fn()
        const { result } = renderHook(() => useFlowExit(onClose))
        act(() => {
          result.current.requestClose()
          result.current.requestClose()
        })
        act(() => {
          vi.runAllTimers()
        })
        expect(onClose).toHaveBeenCalledTimes(1)
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
