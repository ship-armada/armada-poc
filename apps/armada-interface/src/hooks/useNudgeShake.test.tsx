// ABOUTME: Unit tests for useNudgeShake — reduced-motion skips the shake; a nudge flips shaking on (rAF) and clears on animation end.
// ABOUTME: Stubs matchMedia + requestAnimationFrame so the one-shot shake resolves synchronously.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AnimationEvent } from 'react'
import { act, renderHook } from '@testing-library/react'
import { useNudgeShake } from './useNudgeShake'

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion') ? reduced : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
}

/** Run the rAF callback synchronously so the shake flips on within a single act(). */
function stubSyncRaf() {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
}

function animationEnd(target: EventTarget, currentTarget: EventTarget): AnimationEvent<HTMLElement> {
  return { target, currentTarget } as unknown as AnimationEvent<HTMLElement>
}

describe('useNudgeShake', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not shake when the user prefers reduced motion', () => {
    stubReducedMotion(true)
    const { result } = renderHook(() => useNudgeShake())
    act(() => result.current.nudge())
    expect(result.current.shaking).toBe(false)
  })

  it('shakes on nudge when motion is allowed, then clears on a matching animation end', () => {
    stubReducedMotion(false)
    stubSyncRaf()
    const { result } = renderHook(() => useNudgeShake())

    act(() => result.current.nudge())
    expect(result.current.shaking).toBe(true)

    const el = document.createElement('button')
    act(() => result.current.onShakeAnimationEnd(animationEnd(el, el)))
    expect(result.current.shaking).toBe(false)
  })

  it('ignores an animation end bubbled from a child (target !== currentTarget)', () => {
    stubReducedMotion(false)
    stubSyncRaf()
    const { result } = renderHook(() => useNudgeShake())

    act(() => result.current.nudge())
    expect(result.current.shaking).toBe(true)

    const parent = document.createElement('button')
    const child = document.createElement('span')
    act(() => result.current.onShakeAnimationEnd(animationEnd(child, parent)))
    // Still shaking — a bubbled child event must not clear the parent's shake.
    expect(result.current.shaking).toBe(true)
  })
})
