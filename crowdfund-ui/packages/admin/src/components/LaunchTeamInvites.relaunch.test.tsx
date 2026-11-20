// ABOUTME: Tests the admin LaunchTeamInvites panel under the relaunch profile (mocked): hop-1 placements
// ABOUTME: are team inviter wallets and hop-2 placements are the Invited tier.

import { render, screen } from '@testing-library/react'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return {
    ...actual,
    HOP_CONFIGS: actual.HOP_CONFIGS_BY_PROFILE.relaunch,
    hopLabel: (hop: number) => actual.TIER_LABELS_BY_PROFILE.relaunch[hop] ?? `Hop-${hop}`,
  }
})
vi.mock('@/hooks/useTransactionFlow', () => ({
  useTransactionFlow: () => ({
    state: { status: 'idle', txHash: null, receipt: null, error: null },
    execute: vi.fn(),
    reset: vi.fn(),
  }),
}))
vi.mock('./TransactionFlow', () => ({ TransactionFlow: () => null }))

import { LaunchTeamInvites } from './LaunchTeamInvites'

describe('LaunchTeamInvites on the relaunch profile', () => {
  // WHY: a hop-1 placement on the relaunch is a $0-cap team inviter wallet, not a contributor; the
  // operator must see that, and the hop-2 budget as the Invited tier.
  it('labels the budgets and actions as team wallets and the Invited tier', () => {
    render(
      <LaunchTeamInvites
        signer={null}
        crowdfundAddress="0x1234"
        hop1Remaining={5}
        hop2Remaining={500}
        blockTimestamp={0}
        launchTeamInviteEnd={1000}
        provider={null}
      />,
    )
    expect(screen.getByRole('button', { name: 'Add team wallet (5)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Invite to Invited (500)' })).toBeInTheDocument()
    expect(screen.getByText('Team wallets:')).toBeInTheDocument()
    expect(screen.getByText('Invited:')).toBeInTheDocument()
  })
})
