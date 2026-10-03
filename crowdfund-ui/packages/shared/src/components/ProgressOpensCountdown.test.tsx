// ABOUTME: Tests the @armada/ui Progress card's pre-open countdown mode ("OPENS IN …").
// ABOUTME: Before the commit window opens the time tag counts down to the opening, not the close.
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Progress } from '@armada/ui'

const NOW_MS = 1_700_000_000_000

describe('Progress opens countdown', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('reads "OPENS IN N DAYS" when the opening is two or more days away', () => {
    vi.useFakeTimers({ now: NOW_MS })
    render(<Progress endsAt={NOW_MS + 3 * 86_400_000} countdown="opens" animateOnMount={false} />)
    expect(screen.getByText('OPENS IN 3 DAYS')).toBeTruthy()
  })

  it('ticks a live "OPENS IN HH:MM:SS" counter under 48h', () => {
    vi.useFakeTimers({ now: NOW_MS })
    render(<Progress endsAt={NOW_MS + 3_661_000} countdown="opens" animateOnMount={false} />)
    expect(screen.getByText('OPENS IN 01:01:01')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('OPENS IN 01:01:00')).toBeTruthy()
  })

  it('keeps the "N DAYS LEFT" close countdown by default', () => {
    vi.useFakeTimers({ now: NOW_MS })
    render(<Progress endsAt={NOW_MS + 3 * 86_400_000} animateOnMount={false} />)
    expect(screen.getByText('3 DAYS LEFT')).toBeTruthy()
  })
})
