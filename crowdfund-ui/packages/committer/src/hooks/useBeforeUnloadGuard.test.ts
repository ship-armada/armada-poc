// ABOUTME: Tests for useBeforeUnloadGuard — registers/removes the beforeunload handler with `active`.
// ABOUTME: Confirms the native leave-confirmation only fires while a tx pipeline is in flight.

import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useBeforeUnloadGuard } from './useBeforeUnloadGuard'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBeforeUnloadGuard', () => {
  it('registers a beforeunload handler only while active', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    const { rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) => useBeforeUnloadGuard(active),
      { initialProps: { active: false } },
    )
    expect(addSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function))

    rerender({ active: true })
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))

    rerender({ active: false })
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))

    unmount()
  })

  it('removes the handler on unmount while active', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useBeforeUnloadGuard(true))
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))
  })
})
