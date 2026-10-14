// ABOUTME: Tests for the browser polyfills installed at committer startup.
// ABOUTME: AbortSignal.timeout must be added only where missing (Safari < 16) and never replace a native one.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { installPolyfills } from './polyfills'

describe('installPolyfills — AbortSignal.timeout', () => {
  const nativeTimeout = AbortSignal.timeout

  afterEach(() => {
    AbortSignal.timeout = nativeTimeout
    vi.useRealTimers()
  })

  it('leaves an existing AbortSignal.timeout untouched', () => {
    const existing = vi.fn()
    AbortSignal.timeout = existing as unknown as typeof AbortSignal.timeout
    installPolyfills()

    expect(AbortSignal.timeout).toBe(existing)
  })

  it('adds AbortSignal.timeout when the browser lacks it, aborting with a TimeoutError', () => {
    vi.useFakeTimers()
    // Simulate iOS 15 Safari, which has AbortSignal but not AbortSignal.timeout.
    AbortSignal.timeout = undefined as unknown as typeof AbortSignal.timeout
    installPolyfills()

    const signal = AbortSignal.timeout(10_000)
    expect(signal.aborted).toBe(false)

    vi.advanceTimersByTime(9_999)
    expect(signal.aborted).toBe(false)

    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)
    expect((signal.reason as DOMException).name).toBe('TimeoutError')
  })
})
