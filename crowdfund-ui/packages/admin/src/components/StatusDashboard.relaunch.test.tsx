// ABOUTME: Tests for the admin StatusDashboard under the relaunch profile (mocked): no expansion badge or
// ABOUTME: elastic marker, hop 2 labelled by its reserve, and the launch-team budget named by tier.

import { render, screen } from '@testing-library/react'
import type { AdminState } from '@/hooks/useAdminState'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return {
    ...actual,
    CROWDFUND_CONSTANTS: actual.CONSTANTS_BY_PROFILE.relaunch,
    HOP_CONFIGS: actual.HOP_CONFIGS_BY_PROFILE.relaunch,
    hopLabel: (hop: number) => actual.TIER_LABELS_BY_PROFILE.relaunch[hop] ?? `Hop-${hop}`,
  }
})

import { StatusDashboard } from './StatusDashboard'

const USDC = (n: number) => BigInt(n) * 1_000_000n

function makeState(): AdminState {
  return {
    phase: 0, armLoaded: true, totalCommitted: USDC(350_000), cappedDemand: USDC(350_000),
    saleSize: USDC(1_800_000), windowStart: 1000, windowEnd: 100_000, launchTeamInviteEnd: 100_000,
    finalizedAt: 0, claimDeadline: 0, refundMode: false, blockTimestamp: 2000,
    hopStats: [
      { totalCommitted: USDC(300_000), cappedCommitted: USDC(300_000), whitelistCount: 2, uniqueCommitters: 2 },
      { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 1, uniqueCommitters: 0 },
      { totalCommitted: USDC(50_000), cappedCommitted: USDC(50_000), whitelistCount: 5, uniqueCommitters: 5 },
    ],
    participantCount: 12, seedCount: 2, ltBudgetHop1Remaining: 0, ltBudgetHop2Remaining: 495,
    totalAllocatedArm: 0n, totalArmTransferred: 0n, loading: false, error: null,
  }
}

describe('StatusDashboard on the relaunch profile', () => {
  // WHY: BASE_SALE == MAX_SALE, so an "EXPANDED/BASE" badge and an elastic-trigger marker at 100%
  // of the bar describe expansion the sale cannot have.
  it('drops the sale-size badge and the elastic marker', () => {
    render(<StatusDashboard state={makeState()} role="launch_team" />)
    expect(screen.queryByText(/\((BASE|EXPANDED)\)/)).toBeNull()
    expect(screen.queryByText(/Elastic/)).toBeNull()
  })

  // WHY: the relaunch has no bps ceilings or hop-2 floor: hop 2 has first priority for a $300K
  // reserve and the other hops share the remainder, so the Ceiling column must say that rather than
  // "0%" or "Floor".
  it('labels hop 2 by its $300K reserve and the other hops as the remainder', () => {
    render(<StatusDashboard state={makeState()} role="launch_team" />)
    expect(screen.getByText('$300K reserve')).toBeInTheDocument()
    expect(screen.getAllByText('Remainder')).toHaveLength(2)
    expect(screen.queryByText('Floor')).toBeNull()
    expect(screen.queryByText('0%')).toBeNull()
  })

  // WHY: hop-1 placements are team inviter wallets and hop-2 placements the Invited tier.
  it('names the launch-team budgets by tier', () => {
    render(<StatusDashboard state={makeState()} role="launch_team" />)
    expect(screen.getByText('Team wallets remaining:')).toBeInTheDocument()
    expect(screen.getByText('Community remaining:')).toBeInTheDocument()
  })
})
