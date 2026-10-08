// ABOUTME: Tests for the committer's mobile menu nav — Your position and Claim gating, plus the About link.
// ABOUTME: Before the sale opens there is no position to show, so Your position is disabled.
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { CommitterMobileMenu, type CommitterMobileMenuProps } from './CommitterMobileMenu'
import { CROWDFUND_INFO_URL } from '@/config/socials'

vi.mock('wagmi', () => ({
  useAccount: () => ({ connector: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: () => null },
}))

function renderMenu(overrides: Partial<CommitterMobileMenuProps> = {}) {
  const props: CommitterMobileMenuProps = {
    onClose: vi.fn(),
    current: 'network',
    onNavigate: vi.fn(),
    onParticipate: vi.fn(),
    claimAvailable: false,
    myPositionEnabled: true,
    participationEnabled: false,
    usdcBalance: 0n,
    ...overrides,
  }
  render(<CommitterMobileMenu {...props} />)
  return props
}

describe('CommitterMobileMenu nav', () => {
  it('disables Your position before the sale opens', () => {
    const props = renderMenu({ myPositionEnabled: false })
    const item = screen.getByRole('button', { name: 'Your position' })
    expect(item).toBeDisabled()
    item.click()
    expect(props.onNavigate).not.toHaveBeenCalled()
  })

  it('navigates to Your position once the sale has opened', () => {
    const props = renderMenu({ myPositionEnabled: true })
    screen.getByRole('button', { name: 'Your position' }).click()
    expect(props.onNavigate).toHaveBeenCalledWith('my-position')
  })

  it('links About the crowdfund to the crowdfund info page in a new tab, after Claim', () => {
    renderMenu()
    const about = screen.getByRole('link', { name: 'About the crowdfund' })
    expect(about).toHaveAttribute('href', CROWDFUND_INFO_URL)
    expect(about).toHaveAttribute('target', '_blank')
    expect(about).toHaveAttribute('rel', 'noopener noreferrer')
    const claim = screen.getByRole('button', { name: 'Claim' })
    expect(claim.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('closes the menu when About the crowdfund is followed', () => {
    const props = renderMenu()
    const about = screen.getByRole('link', { name: 'About the crowdfund' })
    // Stop jsdom from attempting the (unimplemented) navigation.
    about.addEventListener('click', (e) => e.preventDefault())
    about.click()
    expect(props.onClose).toHaveBeenCalled()
  })
})
