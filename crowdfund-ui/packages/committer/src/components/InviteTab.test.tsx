// ABOUTME: Tests for InviteTab component — slot display, form states, and no-slots view.
// ABOUTME: Covers invite positions, hop selector, self-invite button, and window-closed state.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
    ...overrides,
  }
}

const mockInviteLinks: UseInviteLinksResult = {
  links: [],
  loading: false,
  createLink: vi.fn(),
  revokeLink: vi.fn(),
  revokeTx: {
    state: { status: 'idle', txHash: null, receipt: null, error: null },
    execute: vi.fn(),
    reset: vi.fn(),
  },
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

  it('renders invite slot summary', () => {
    renderInviteTab()
    expect(screen.getByText('Your Invite Slots')).toBeInTheDocument()
    expect(screen.getByText('Seed (hop-0)')).toBeInTheDocument()
    expect(screen.getByText(/1 used/)).toBeInTheDocument()
    expect(screen.getByText('2 remaining')).toBeInTheDocument()
  })

  it('renders self-invite button', () => {
    renderInviteTab()
    expect(screen.getByText('Self')).toBeInTheDocument()
  })

  it('renders send invite form', () => {
    renderInviteTab()
    expect(screen.getByText('Send Direct Invite')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('0x... or ENS name')).toBeInTheDocument()
    expect(screen.getByText('Send Invite')).toBeInTheDocument()
  })

  it('renders invite link section', () => {
    renderInviteTab()
    expect(screen.getByText('Invite Links (EIP-712)')).toBeInTheDocument()
  })
})
