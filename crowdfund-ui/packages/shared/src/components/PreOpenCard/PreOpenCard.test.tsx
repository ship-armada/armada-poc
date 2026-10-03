// ABOUTME: Tests for the hero's pre-open card — a live countdown to the commit window opening.
// ABOUTME: Ticks every second, shows the local opening time, links Discord / X, and reads "Opening now" at zero.
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { PreOpenCard } from './PreOpenCard'
import { DISCORD_URL, X_URL } from '../../lib/socials'

const NOW_S = 1_700_000_000

describe('PreOpenCard', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('counts down to the opening and ticks every second', () => {
    vi.useFakeTimers({ now: NOW_S * 1000 })
    render(<PreOpenCard opensAtUnix={NOW_S + 2 * 86400 + 4 * 3600 + 12 * 60 + 33} />)
    const timer = screen.getByRole('timer')
    expect(timer.textContent).toBe('02d 04h 12m 33s')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(timer.textContent).toBe('02d 04h 12m 32s')
  })

  it('shows the local opening time', () => {
    vi.useFakeTimers({ now: NOW_S * 1000 })
    render(<PreOpenCard opensAtUnix={NOW_S + 3600} />)
    expect(screen.getByText(/^Opens /)).toBeTruthy()
  })

  it('links to the Armada Discord and X accounts', () => {
    vi.useFakeTimers({ now: NOW_S * 1000 })
    render(<PreOpenCard opensAtUnix={NOW_S + 3600} />)
    expect(screen.getByRole('link', { name: /Discord/ }).getAttribute('href')).toBe(DISCORD_URL)
    expect(screen.getByRole('link', { name: /X/ }).getAttribute('href')).toBe(X_URL)
  })

  it('reads "Opening now" once the countdown reaches zero', () => {
    vi.useFakeTimers({ now: NOW_S * 1000 })
    render(<PreOpenCard opensAtUnix={NOW_S + 1} />)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByRole('timer').textContent).toBe('Opening now')
  })
})
