// ABOUTME: Tests for useStepTransition — a step change plays the exit, then swaps the shown step.
// ABOUTME: Drives the hook with fake timers; no rendering of real flow screens.
// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useStepTransition, STEP_EXIT_MS } from './useStepTransition'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useStepTransition', () => {
  it('shows the initial step with no exit running', () => {
    const { result } = renderHook(() => useStepTransition('splash'))
    expect(result.current).toEqual({ shownStep: 'splash', exiting: false })
  })

  it('swaps at once while the flow is still resolving its starting step on mount', () => {
    const { result, rerender } = renderHook(({ step }) => useStepTransition(step), {
      initialProps: { step: 'wallet' },
    })
    // e.g. a connected wallet auto-advances past the connect step on open.
    rerender({ step: 'splash' })
    expect(result.current).toEqual({ shownStep: 'splash', exiting: false })
  })

  it('keeps showing the old step while it exits, then swaps to the new one', () => {
    const { result, rerender } = renderHook(({ step }) => useStepTransition(step), {
      initialProps: { step: 'splash' },
    })
    act(() => vi.advanceTimersByTime(0)) // settled after mount

    rerender({ step: 'commit' })
    expect(result.current).toEqual({ shownStep: 'splash', exiting: true })

    act(() => vi.advanceTimersByTime(STEP_EXIT_MS - 1))
    expect(result.current.shownStep).toBe('splash')

    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toEqual({ shownStep: 'commit', exiting: false })
  })

  it('lands on the latest step when the step changes again mid-exit', () => {
    const { result, rerender } = renderHook(({ step }) => useStepTransition(step), {
      initialProps: { step: 'commit' },
    })
    act(() => vi.advanceTimersByTime(0)) // settled after mount

    rerender({ step: 'review' })
    act(() => vi.advanceTimersByTime(STEP_EXIT_MS / 2))
    rerender({ step: 'approve' })
    act(() => vi.advanceTimersByTime(STEP_EXIT_MS))

    expect(result.current).toEqual({ shownStep: 'approve', exiting: false })
  })

  it('cancels a pending swap when the step returns to the shown one', () => {
    const { result, rerender } = renderHook(({ step }) => useStepTransition(step), {
      initialProps: { step: 'commit' },
    })
    act(() => vi.advanceTimersByTime(0)) // settled after mount

    rerender({ step: 'review' })
    rerender({ step: 'commit' })
    expect(result.current).toEqual({ shownStep: 'commit', exiting: false })

    act(() => vi.advanceTimersByTime(STEP_EXIT_MS))
    expect(result.current).toEqual({ shownStep: 'commit', exiting: false })
  })
})
