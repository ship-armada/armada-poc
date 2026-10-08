// ABOUTME: Tests for PageNav — Crowdfund / Your position / Claim tabs plus the external About link.
// ABOUTME: Claim gated until open; About sits outside the pill strip, desktop only; no social links in the nav.

import { render, screen } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { PageNav } from './appNav'
import { CROWDFUND_INFO_URL } from '@/config/socials'

/** Force `useIsMobileLayout` to report the ≤767px layout for one test. */
function mockMobileViewport() {
  const original = window.matchMedia
  window.matchMedia = (query: string) => ({ ...original(query), matches: true })
  return () => {
    window.matchMedia = original
  }
}

describe('PageNav', () => {
  it('renders Crowdfund, Your position, and Claim', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Crowdfund' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Your position' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Claim' })).toBeInTheDocument()
  })

  describe('About link', () => {
    let restoreMatchMedia: (() => void) | undefined
    afterEach(() => {
      restoreMatchMedia?.()
      restoreMatchMedia = undefined
    })

    it('renders About the crowdfund after Claim as a new-tab link to the crowdfund info page', () => {
      render(<PageNav current="network" onChange={vi.fn()} />)
      const about = screen.getByRole('link', { name: 'About the crowdfund' })
      expect(about).toHaveAttribute('href', CROWDFUND_INFO_URL)
      expect(about).toHaveAttribute('target', '_blank')
      expect(about).toHaveAttribute('rel', 'noopener noreferrer')
      const claim = screen.getByRole('button', { name: 'Claim' })
      expect(claim.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('sits outside the page-tab pill strip, so it reads as leaving the app', () => {
      render(<PageNav current="network" onChange={vi.fn()} />)
      const strip = screen.getByRole('button', { name: 'Claim' }).closest('nav')
      expect(strip).not.toBeNull()
      expect(strip!.contains(screen.getByRole('link', { name: 'About the crowdfund' }))).toBe(false)
    })

    it('is hidden below a 1000px-wide viewport', () => {
      // jsdom applies no CSS, so assert the Tailwind breakpoint class that does
      // the hiding (`max-[1000px]` = width < 1000px in Tailwind v4).
      render(<PageNav current="network" onChange={vi.fn()} />)
      expect(screen.getByRole('link', { name: 'About the crowdfund' })).toHaveClass(
        'max-[1000px]:hidden',
      )
    })

    it('renders About in the vertical nav too', () => {
      render(<PageNav current="network" onChange={vi.fn()} orientation="vertical" />)
      expect(screen.getByRole('link', { name: 'About the crowdfund' })).toHaveAttribute('href', CROWDFUND_INFO_URL)
    })

    it('omits About on the mobile layout, where the nav renders as a pill strip', () => {
      restoreMatchMedia = mockMobileViewport()
      render(<PageNav current="network" onChange={vi.fn()} />)
      expect(screen.queryByRole('link', { name: 'About the crowdfund' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Claim' })).toBeInTheDocument()
    })
  })

  it('disables Claim until claimEnabled', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <PageNav current="network" onChange={onChange} claimEnabled={false} />,
    )
    expect(screen.getByRole('button', { name: 'Claim' })).toBeDisabled()

    rerender(<PageNav current="network" onChange={onChange} claimEnabled />)
    expect(screen.getByRole('button', { name: 'Claim' })).toBeEnabled()
  })

  it('disables Your position when myPositionEnabled is false (pre-open)', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <PageNav current="network" onChange={onChange} myPositionEnabled={false} />,
    )
    expect(screen.getByRole('button', { name: 'Your position' })).toBeDisabled()

    rerender(<PageNav current="network" onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Your position' })).toBeEnabled()
  })

  it('disables Your position in the vertical (mobile) nav too', () => {
    render(
      <PageNav
        current="network"
        onChange={vi.fn()}
        orientation="vertical"
        myPositionEnabled={false}
      />,
    )
    expect(screen.getByRole('button', { name: 'Your position' })).toBeDisabled()
  })

  it('never marks Claim as the selected page tab', () => {
    render(<PageNav current="claim" onChange={vi.fn()} claimEnabled />)
    expect(screen.getByRole('button', { name: 'Claim' })).not.toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('no longer renders the social links in the header', () => {
    render(<PageNav current="network" onChange={vi.fn()} />)
    expect(screen.queryByRole('link', { name: 'Armada on Discord' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Armada on X' })).toBeNull()
  })
})
