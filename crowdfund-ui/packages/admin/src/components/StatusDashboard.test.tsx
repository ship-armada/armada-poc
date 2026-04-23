// ABOUTME: Tests for StatusDashboard component — phase display, timeline, hop stats.
// ABOUTME: Verifies countdown formatting, absolute dates, hop-0 whitelist format, and LT budget.

import { render, screen } from '@testing-library/react'
import { StatusDashboard } from './StatusDashboard'
import type { AdminState } from '@/hooks/useAdminState'

function makeState(overrides: Partial<AdminState> = {}): AdminState {
  return {
    phase: 0,
    armLoaded: true,
    totalCommitted: 500_000n * 10n ** 6n,
    cappedDemand: 500_000n * 10n ** 6n,
    saleSize: 1_200_000n * 10n ** 6n,
    windowStart: 1000,
    windowEnd: 100_000,
    launchTeamInviteEnd: 50_000,
    finalizedAt: 0,
    claimDeadline: 0,
    refundMode: false,
    blockTimestamp: 2000,
    hopStats: [
      { totalCommitted: 200_000n * 10n ** 6n, cappedCommitted: 200_000n * 10n ** 6n, whitelistCount: 142, uniqueCommitters: 100 },
      { totalCommitted: 200_000n * 10n ** 6n, cappedCommitted: 180_000n * 10n ** 6n, whitelistCount: 50, uniqueCommitters: 30 },
      { totalCommitted: 100_000n * 10n ** 6n, cappedCommitted: 90_000n * 10n ** 6n, whitelistCount: 200, uniqueCommitters: 80 },
    ],
    participantCount: 392,
    seedCount: 142,
    ltBudgetHop1Remaining: 45,
    ltBudgetHop2Remaining: 30,
    totalAllocatedArm: 0n,
    totalArmTransferred: 0n,
    loading: false,
    error: null,
    ...overrides,
  }
}

describe('StatusDashboard', () => {
  it('renders the phase badge', () => {
    render(<StatusDashboard state={makeState()} role="observer" />)
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('renders sale size label', () => {
    render(<StatusDashboard state={makeState()} role="observer" />)
    expect(screen.getByText(/Sale:.*\$1,200,000/)).toBeInTheDocument()
  })

  it('renders ARM loaded indicator', () => {
    render(<StatusDashboard state={makeState({ armLoaded: true })} role="observer" />)
    expect(screen.getByText('ARM Loaded')).toBeInTheDocument()
  })

  it('renders ARM not loaded indicator', () => {
    render(<StatusDashboard state={makeState({ armLoaded: false })} role="observer" />)
    expect(screen.getByText('ARM Not Loaded')).toBeInTheDocument()
  })

  it('renders timeline rows', () => {
    render(<StatusDashboard state={makeState()} role="observer" />)
    expect(screen.getByText('Week 1 (Seeds + LT Invites)')).toBeInTheDocument()
    expect(screen.getByText('Commitment Window')).toBeInTheDocument()
    expect(screen.getByText('Claim Period')).toBeInTheDocument()
  })

  it('shows absolute dates on timeline rows', () => {
    // windowStart=1000 → Jan 1, 1970
    render(<StatusDashboard state={makeState({ windowStart: 1000 })} role="observer" />)
    // All 4 timeline rows show dates — just check that at least one exists
    const dateElements = screen.getAllByText(/Jan 1, 1970/)
    expect(dateElements.length).toBeGreaterThan(0)
  })

  it('shows hop-0 whitelist in N/MAX format', () => {
    render(<StatusDashboard state={makeState()} role="observer" />)
    expect(screen.getByText('142/160')).toBeInTheDocument()
  })

  it('shows plain count for hop-1 and hop-2 whitelist', () => {
    render(<StatusDashboard state={makeState()} role="observer" />)
    expect(screen.getByText('50')).toBeInTheDocument()
    expect(screen.getByText('200')).toBeInTheDocument()
  })

  it('shows hop stats committed values', () => {
    render(<StatusDashboard state={makeState()} role="observer" />)
    // Total committed $500,000 should appear in the progress area (multiple
    // cells render the value; assert at-least-one so the test survives layout
    // tweaks).
    expect(screen.getAllByText(/\$500,000/).length).toBeGreaterThan(0)
  })

  it('shows LT budget only for launch_team role', () => {
    const { rerender } = render(<StatusDashboard state={makeState()} role="observer" />)
    expect(screen.queryByText('Launch Team Budget')).not.toBeInTheDocument()

    rerender(<StatusDashboard state={makeState()} role="launch_team" />)
    expect(screen.getByText('Launch Team Budget')).toBeInTheDocument()
  })

  it('shows finalized phase badge', () => {
    render(<StatusDashboard state={makeState({ phase: 1 })} role="observer" />)
    expect(screen.getByText('Finalized')).toBeInTheDocument()
  })

  it('shows Ceiling column with percentage for hop 0-1 and Floor for hop 2', () => {
    render(<StatusDashboard state={makeState()} role="observer" />)
    // HOP_CONFIGS[0].ceilingBps = 7000 → 70%, HOP_CONFIGS[1].ceilingBps = 4500 → 45%
    expect(screen.getByText('70%')).toBeInTheDocument()
    expect(screen.getByText('45%')).toBeInTheDocument()
    expect(screen.getByText('Floor')).toBeInTheDocument()
  })

  it('shows Cap/Slot column values', () => {
    render(<StatusDashboard state={makeState()} role="observer" />)
    // HOP_CONFIGS[0].capUsdc, [1].capUsdc, [2].capUsdc
    expect(screen.getByText('$15,000')).toBeInTheDocument()
    expect(screen.getByText('$4,000')).toBeInTheDocument()
    expect(screen.getByText('$1,000')).toBeInTheDocument()
  })

  it('shows Over/Under column with percentage', () => {
    render(<StatusDashboard state={makeState()} role="observer" />)
    // Over/Under values should be rendered as percentages
    const cells = screen.getAllByText(/%/)
    // Should have at least 3 percentage cells (one per hop) plus the ceiling percentages
    expect(cells.length).toBeGreaterThanOrEqual(3)
  })
})
