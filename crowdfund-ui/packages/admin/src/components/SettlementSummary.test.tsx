// ABOUTME: Tests for SettlementSummary component — post-finalization stats.
// ABOUTME: Verifies ARM claim tracking, net proceeds, and refund breakdown.

import { render, screen } from '@testing-library/react'
import { SettlementSummary } from './SettlementSummary'
import type { AdminState } from '@/hooks/useAdminState'
import type { CrowdfundEvent } from '@armada/crowdfund-shared'

function makeState(overrides: Partial<AdminState> = {}): AdminState {
  return {
    phase: 1,
    armLoaded: true,
    totalCommitted: 1_300_000n * 10n ** 6n,
    cappedDemand: 1_300_000n * 10n ** 6n,
    saleSize: 1_200_000n * 10n ** 6n,
    windowStart: 1000,
    windowEnd: 100_000,
    launchTeamInviteEnd: 50_000,
    finalizedAt: 150_000,
    claimDeadline: 200_000,
    refundMode: false,
    blockTimestamp: 160_000,
    hopStats: [],
    participantCount: 100,
    seedCount: 50,
    ltBudgetHop1Remaining: 0,
    ltBudgetHop2Remaining: 0,
    totalAllocatedArm: 1_200_000n * 10n ** 18n,
    totalArmTransferred: 600_000n * 10n ** 18n,
    loading: false,
    error: null,
    ...overrides,
  }
}

describe('SettlementSummary', () => {
  it('shows sale size', () => {
    render(<SettlementSummary state={makeState()} events={[]} />)
    expect(screen.getByText('$1,200,000')).toBeInTheDocument()
  })

  it('shows refund mode status', () => {
    render(<SettlementSummary state={makeState({ refundMode: false })} events={[]} />)
    expect(screen.getByText('No')).toBeInTheDocument()
  })

  it('shows ARM claimed percentage', () => {
    render(<SettlementSummary state={makeState()} events={[]} />)
    expect(screen.getByText(/50\.0%/)).toBeInTheDocument()
  })

  it('shows ARM unclaimed', () => {
    render(<SettlementSummary state={makeState()} events={[]} />)
    // Both "ARM claimed" and "ARM unclaimed" show 600,000 ARM (50/50 split)
    const armTexts = screen.getAllByText(/600,000 ARM/)
    expect(armTexts.length).toBeGreaterThanOrEqual(2)
  })

  // WHY: Finalized.netProceeds is the full allocation; where the contract paid the launch team
  // (LaunchTeamPaid), the summary must show that payment and the treasury's smaller share.
  it('shows the launch-team payment and treasury proceeds when the team was paid', () => {
    const events = [
      { type: 'LaunchTeamPaid', blockNumber: 1, transactionHash: '0x1', logIndex: 0, args: { recipient: '0xteam', amount: 250_000n * 10n ** 6n } },
      { type: 'Finalized', blockNumber: 1, transactionHash: '0x1', logIndex: 1, args: { netProceeds: 1_000_000n * 10n ** 6n } },
    ] as CrowdfundEvent[]
    render(<SettlementSummary state={makeState()} events={events} />)
    expect(screen.getByText('Launch team paid:').parentElement?.textContent).toContain('$250,000')
    expect(screen.getByText('Treasury proceeds:').parentElement?.textContent).toContain('$750,000')
  })

  it('omits the launch-team lines when no payment was made', () => {
    const events = [
      { type: 'Finalized', blockNumber: 1, transactionHash: '0x1', logIndex: 0, args: { netProceeds: 1_000_000n * 10n ** 6n } },
    ] as CrowdfundEvent[]
    render(<SettlementSummary state={makeState()} events={events} />)
    expect(screen.queryByText('Launch team paid:')).toBeNull()
    expect(screen.queryByText('Treasury proceeds:')).toBeNull()
  })

  it('shows governance quiet period countdown when still active', () => {
    // finalizedAt=150_000, quiet period=10d=864000, so quietEnd=1_014_000
    // blockTimestamp=160_000 → 854_000 seconds remaining
    render(<SettlementSummary state={makeState()} events={[]} />)
    expect(screen.getByText(/Governance quiet period/)).toBeInTheDocument()
    expect(screen.getByText(/ends in/)).toBeInTheDocument()
  })

  it('shows governance quiet period as ended when past', () => {
    // finalizedAt=150_000, quietEnd=1_014_000, blockTimestamp=1_100_000 → ended
    render(
      <SettlementSummary
        state={makeState({ blockTimestamp: 1_100_000 })}
        events={[]}
      />,
    )
    expect(screen.getByText(/Governance quiet period/)).toBeInTheDocument()
    expect(screen.getByText(/^ended/)).toBeInTheDocument()
  })

  it('extracts net proceeds from Finalized event', () => {
    const events: CrowdfundEvent[] = [
      {
        type: 'Finalized',
        args: { saleSize: 1_200_000n * 10n ** 6n, netProceeds: 1_100_000n * 10n ** 6n, refundMode: false },
        blockNumber: 100,
        logIndex: 0,
        transactionHash: '0xabc',
      },
    ]
    render(<SettlementSummary state={makeState()} events={events} />)
    expect(screen.getByText('$1,100,000')).toBeInTheDocument()
  })
})
