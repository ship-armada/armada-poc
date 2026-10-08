// ABOUTME: Integration tests for the pre-launch committer — the hero's pre-open state from a fixed opening time.
// ABOUTME: Guards that it shows the countdown, exposes no sale actions, reads no network, and reloads after opening.
// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PreLaunchApp } from './PreLaunchApp'
import { PRELAUNCH_RELOAD_CHECK_MS } from '@/config/prelaunch'
import { CROWDFUND_INFO_URL, PROJECT_URL } from '@/config/socials'

// Thu 2026-10-08 17:00:00 UTC.
const OPENS_AT = 1791478800

describe('PreLaunchApp', () => {
  // jsdom has no WebGL — force NodeSphere's static fallback so the hero
  // renders without the expected WebGL-context error.
  beforeEach(() => window.history.replaceState({}, '', '/?nowebgl'))
  afterEach(() => {
    window.history.replaceState({}, '', '/')
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the OPENS SOON status and a countdown to the announced opening', () => {
    // 1 day, 2 hours, 3 minutes, 4 seconds before the opening.
    vi.useFakeTimers({ now: (OPENS_AT - 93_784) * 1000 })
    render(<PreLaunchApp opensAtUnix={OPENS_AT} onReload={vi.fn()} />)

    expect(screen.getAllByText('OPENS SOON').length).toBeGreaterThan(0)
    expect(screen.getByRole('region', { name: 'Sale opens soon' })).toBeTruthy()
    expect(screen.getByRole('timer').textContent).toBe('01d 02h 03m 04s')
  })

  it('exposes no wallet, participate, details or position actions', () => {
    vi.useFakeTimers({ now: (OPENS_AT - 3600) * 1000 })
    render(<PreLaunchApp opensAtUnix={OPENS_AT} onReload={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /connect wallet/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /participate/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /details/i })).toBeNull()
    // Your position and Claim stay visible in the nav (desktop and mobile
    // copies) but are not navigable.
    for (const name of ['Your position', 'Claim']) {
      const tabs = screen.getAllByRole('button', { name })
      expect(tabs.length).toBeGreaterThan(0)
      for (const tab of tabs) expect(tab).toBeDisabled()
    }
  })

  it('links the logo to the project site and About the crowdfund (desktop nav and mobile logo row) to the crowdfund info page', () => {
    vi.useFakeTimers({ now: (OPENS_AT - 3600) * 1000 })
    render(<PreLaunchApp opensAtUnix={OPENS_AT} onReload={vi.fn()} />)

    expect(screen.getByRole('link', { name: 'Armada project site' })).toHaveAttribute(
      'href',
      PROJECT_URL,
    )
    // jsdom renders every breakpoint's copy (CSS shows one): the desktop
    // nav's links sit inside a <nav>, the mobile logo-row copy does not.
    const about = screen.getAllByRole('link', { name: 'About the crowdfund' })
    for (const link of about) expect(link).toHaveAttribute('href', CROWDFUND_INFO_URL)
    expect(about.some((link) => link.closest('nav') !== null)).toBe(true)
    expect(about.some((link) => link.closest('nav') === null)).toBe(true)
  })

  it('shows no demo participants or invite slots', () => {
    vi.useFakeTimers({ now: (OPENS_AT - 3600) * 1000 })
    render(<PreLaunchApp opensAtUnix={OPENS_AT} onReload={vi.fn()} />)

    // Same empty participants panel as the live pre-open state.
    expect(screen.getAllByText('No participants yet').length).toBeGreaterThan(0)
    // The demo invite slots carry this fake link; the empty hero must not.
    expect(document.body.textContent).not.toContain('invite=abc123')
  })

  it('makes no network requests (no manifest, RPC or indexer)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.useFakeTimers({ now: (OPENS_AT - 3600) * 1000 })
    render(<PreLaunchApp opensAtUnix={OPENS_AT} onReload={vi.fn()} />)
    act(() => {
      vi.advanceTimersByTime(5 * 60_000)
    })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reloads once the opening has passed, and not before', () => {
    const onReload = vi.fn()
    // Opens 90s from now: the first check (60s) is still before the opening.
    vi.useFakeTimers({ now: (OPENS_AT - 90) * 1000 })
    render(<PreLaunchApp opensAtUnix={OPENS_AT} onReload={onReload} />)

    act(() => {
      vi.advanceTimersByTime(PRELAUNCH_RELOAD_CHECK_MS)
    })
    expect(onReload).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(PRELAUNCH_RELOAD_CHECK_MS)
    })
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})
