// ABOUTME: Tests for lib/paint — yieldToPaint resolves via rAF when present and via setTimeout otherwise.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { yieldToPaint } from './paint'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('yieldToPaint', () => {
  it('resolves via requestAnimationFrame when available', async () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('requestAnimationFrame', raf)
    await yieldToPaint()
    expect(raf).toHaveBeenCalledTimes(1)
  })

  it('falls back to setTimeout in a non-DOM context (no requestAnimationFrame)', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    // Must still resolve so callers can await unconditionally.
    await expect(yieldToPaint()).resolves.toBeUndefined()
  })
})
