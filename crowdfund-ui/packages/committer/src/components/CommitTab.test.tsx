// ABOUTME: Tests for CommitTab component — eligibility, window states, validation, and rendering.
// ABOUTME: Covers not-eligible, window-closed, input rendering, and balance validation.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CommitTab } from './CommitTab'
import type { CommitTabProps } from './CommitTab'
import type { HopPosition } from '@/hooks/useEligibility'
import type { HopStatsData } from '@armada/crowdfund-shared'

const USDC = 10n ** 6n

const defaultHopStats: HopStatsData[] = [
  { totalCommitted: 0n, cappedCommitted: 0n, uniqueCommitters: 0, whitelistCount: 0 },
  { totalCommitted: 0n, cappedCommitted: 0n, uniqueCommitters: 0, whitelistCount: 0 },
  { totalCommitted: 0n, cappedCommitted: 0n, uniqueCommitters: 0, whitelistCount: 0 },
]

function makePosition(overrides: Partial<HopPosition> = {}): HopPosition {
  return {
    hop: 0,
    invitesReceived: 1,
    committed: 0n,
    effectiveCap: 15_000n * USDC,
    remaining: 15_000n * USDC,
    invitesUsed: 0,
    invitesAvailable: 3,
    invitedBy: ['armada'],
    ...overrides,
  }
}

function renderCommitTab(overrides: Partial<CommitTabProps> = {}) {
  const defaultProps: CommitTabProps = {
    positions: [makePosition()],
    eligible: true,
    balance: 50_000n * USDC,
    needsApproval: () => false,
    refreshAllowance: vi.fn(),
    signer: null,
    crowdfundAddress: '0x1234567890abcdef1234567890abcdef12345678',
    usdcAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    hopStats: defaultHopStats,
    saleSize: 1_200_000n * USDC,
    phase: 0,
    windowOpen: true,
    resolveENS: () => null,
    ...overrides,
  }
  return render(<CommitTab {...defaultProps} />)
}

describe('CommitTab', () => {
  it('shows not-eligible message when not eligible', () => {
    renderCommitTab({ eligible: false, positions: [] })
    expect(screen.getByText('Not Eligible')).toBeInTheDocument()
  })

  it('shows window-closed message when phase !== 0', () => {
    renderCommitTab({ phase: 1 })
    expect(screen.getByText('Commitment window is closed.')).toBeInTheDocument()
  })

  it('shows window-not-open message when windowOpen is false', () => {
    renderCommitTab({ windowOpen: false })
    expect(screen.getByText('Commitment window is not yet open.')).toBeInTheDocument()
  })

  it('renders per-hop input cards when eligible and window open', () => {
    renderCommitTab()
    // hopLabel(0) returns "Seed (hop-0)" — appears in eligibility display and input card
    expect(screen.getAllByText('Seed (hop-0)').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Review Commitment')).toBeInTheDocument()
  })

  it('renders multiple hop inputs for multi-position user', () => {
    renderCommitTab({
      positions: [
        makePosition({ hop: 0 }),
        makePosition({ hop: 1, effectiveCap: 8_000n * USDC, remaining: 8_000n * USDC, invitedBy: ['0x1234567890abcdef1234567890abcdef12345678'] }),
      ],
    })
    expect(screen.getAllByText('Seed (hop-0)').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Hop-1').length).toBeGreaterThanOrEqual(1)
  })

  it('shows cap reached warning when remaining is 0', () => {
    renderCommitTab({
      positions: [makePosition({ remaining: 0n })],
    })
    expect(screen.getByText('Cap reached at this hop')).toBeInTheDocument()
  })

  it('renders eligibility display with inviter attribution', () => {
    renderCommitTab()
    expect(screen.getByText('Your positions:')).toBeInTheDocument()
    expect(screen.getByText(/invited by Armada/)).toBeInTheDocument()
  })

  it('disables Review button when no amounts entered', () => {
    renderCommitTab()
    const btn = screen.getByText('Review Commitment')
    expect(btn).toBeDisabled()
  })
})
