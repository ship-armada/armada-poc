// ABOUTME: Tests for the admin LaunchTeamInvites panel: the repeat-invite notice reflects the hop's
// ABOUTME: stacking cap (a slot is added below it; the contract reverts at it). Mainnet profile values.

import { render, screen, fireEvent, waitFor } from '@testing-library/react'

let invitesReceived = 0

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: vi.fn(function () {
      return { participants: () => Promise.resolve({ invitesReceived }) }
    }),
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

const ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

function renderPanel() {
  render(
    <LaunchTeamInvites
      signer={null}
      crowdfundAddress="0x1234"
      hop1Remaining={5}
      hop2Remaining={500}
      blockTimestamp={0}
      launchTeamInviteEnd={1000}
      provider={{} as never}
    />,
  )
  fireEvent.change(screen.getByPlaceholderText(/invitee address|ENS name/i), { target: { value: ADDR } })
}

describe('LaunchTeamInvites repeat-invite notice', () => {
  // WHY: below the hop's stacking cap a repeat invite adds a slot (and raises the cap).
  it('explains the extra slot while the address is below the stacking cap', async () => {
    invitesReceived = 1
    renderPanel()
    expect(await screen.findByText(/This invite adds another slot/)).toBeInTheDocument()
  })

  // WHY: at the cap the contract rejects the invite (on the relaunch the cap is 1 at every hop, so
  // any repeat reverts). Promising "another slot" there would send a transaction that fails.
  it('warns that the invite will revert once the address is at the stacking cap', async () => {
    invitesReceived = 10 // mainnet hop-1 maxInvitesReceived
    renderPanel()
    expect(await screen.findByText(/this invite will revert/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/This invite adds another slot/)).toBeNull())
  })
})
