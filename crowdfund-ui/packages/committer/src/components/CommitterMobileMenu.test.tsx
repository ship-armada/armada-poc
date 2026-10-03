// ABOUTME: Tests for the committer's mobile menu nav — Your position and Claim gating.
// ABOUTME: Before the sale opens there is no position to show, so Your position is disabled.
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { CommitterMobileMenu, type CommitterMobileMenuProps } from './CommitterMobileMenu'

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
})
