// ABOUTME: Tests for InviteTab component — slot display, mode picker, step navigation.
// ABOUTME: Walks through mode → details → review for direct, mode → link for shareable.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InviteTab } from './InviteTab'
import type { InviteTabProps } from './InviteTab'
import type { HopPosition } from '@/hooks/useEligibility'
import type { UseInviteLinksResult } from '@/hooks/useInviteLinks'

const USDC = 10n ** 6n

function makePosition(overrides: Partial<HopPosition> = {}): HopPosition {
  return {
    hop: 0,
    invitesReceived: 1,
    committed: 0n,
    effectiveCap: 15_000n * USDC,
    remaining: 15_000n * USDC,
    invitesUsed: 1,
    invitesAvailable: 2,
    invitedBy: ['armada'],
    ...overrides,
  }
}

const mockInviteLinks: UseInviteLinksResult = {
  links: [],
  loading: false,
  createLink: vi.fn(),
  revokeLink: vi.fn(),
  refreshLinks: vi.fn(),
}

function renderInviteTab(overrides: Partial<InviteTabProps> = {}) {
  const defaultProps: InviteTabProps = {
    positions: [makePosition()],
    signer: null,
    address: '0xabc123abc123abc123abc123abc123abc123abc1',
    crowdfundAddress: '0x1234567890abcdef1234567890abcdef12345678',
    phase: 0,
    windowOpen: true,
    inviteLinks: mockInviteLinks,
    blockTimestamp: 1700000000,
    nodes: new Map(),
    provider: null,
    ...overrides,
  }
  return render(<InviteTab {...defaultProps} />)
}

describe('InviteTab', () => {
  it('shows no-slots message when no invite positions', () => {
    renderInviteTab({
      positions: [makePosition({ invitesAvailable: 0 })],
    })
    expect(screen.getByText('No Invite Slots Available')).toBeInTheDocument()
  })

  it('shows window-closed message when not in active window', () => {
    renderInviteTab({ phase: 1 })
    expect(screen.getByText(/Invites can only be sent during/)).toBeInTheDocument()
  })

  it('shows window-closed message when windowOpen is false', () => {
    renderInviteTab({ windowOpen: false })
    expect(screen.getByText(/Invites can only be sent during/)).toBeInTheDocument()
  })

  it('lands on the mode step with slot summary and both invite types', () => {
    renderInviteTab()
    expect(screen.getByText('Your invite slots')).toBeInTheDocument()
    expect(screen.getByText('Seed (hop-0)')).toBeInTheDocument()
    expect(screen.getByText(/1 used/)).toBeInTheDocument()
    expect(screen.getByText('2 remaining')).toBeInTheDocument()
    expect(screen.getByText('Direct on-chain invite')).toBeInTheDocument()
    expect(screen.getByText('Shareable link')).toBeInTheDocument()
  })

  it('advances from mode → details (direct) showing the address input', () => {
    renderInviteTab()
    // Default mode is 'direct'; clicking Continue progresses to details.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByPlaceholderText('0x… or ENS name')).toBeInTheDocument()
  })

  it('switching to link mode and continuing renders the invite link section', () => {
    renderInviteTab()
    fireEvent.click(screen.getByText('Shareable link'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Invite Links (EIP-712)')).toBeInTheDocument()
  })
})
