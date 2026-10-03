// ABOUTME: Tests the /invite landing pre-check against crowdfund sale states (not open, cancelled, closed, active).
// ABOUTME: A link that can't be redeemed must say so before Join, not after the invitee pays for an approve.
// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InviteLandingPage } from './InviteLandingPage'

const NOW = 1_800_000_000

// Per-test chain state read by the mocked contract.
let chain: {
  phase: number
  armLoaded: boolean
  windowStart: number
  windowEnd: number
}

vi.mock('@/config/deployments', () => ({
  loadDeployment: () =>
    Promise.resolve({ contracts: { crowdfund: '0x' + 'c'.repeat(40) }, deployBlock: 0 }),
}))

vi.mock('@armada/crowdfund-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@armada/crowdfund-shared')>()),
  createProvider: () => ({ getBlock: () => Promise.resolve({ timestamp: NOW }) }),
}))

vi.mock('ethers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ethers')>()),
  Contract: vi.fn(function () {
    return {
      phase: () => Promise.resolve(BigInt(chain.phase)),
      armLoaded: () => Promise.resolve(chain.armLoaded),
      windowStart: () => Promise.resolve(BigInt(chain.windowStart)),
      windowEnd: () => Promise.resolve(BigInt(chain.windowEnd)),
      usedNonces: () => Promise.resolve(false),
      getInvitesRemaining: () => Promise.resolve(3n),
      filters: { InviteNonceRevoked: () => ({}) },
      queryFilter: () => Promise.resolve([]),
    }
  }),
}))

const inviter = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const link = `/invite?inviter=${inviter}&fromHop=0&nonce=1&deadline=${NOW + 86_400}&sig=0x${'1'.repeat(130)}`

function renderLanding() {
  render(
    <MemoryRouter initialEntries={[link]}>
      <InviteLandingPage />
    </MemoryRouter>,
  )
}

const OPEN = { phase: 0, armLoaded: true, windowStart: NOW - 3_600, windowEnd: NOW + 86_400 }

beforeEach(() => {
  chain = { ...OPEN }
})

describe('InviteLandingPage sale-state pre-check', () => {
  it('lets the invitee join while the window is open', async () => {
    renderLanding()
    await waitFor(() => expect(screen.getByRole('button', { name: /join/i })).toBeTruthy())
    expect(screen.queryByText(/hasn't opened yet|was cancelled|deadline has passed/)).toBeNull()
  })

  it('says the crowdfund has not opened yet before the window starts', async () => {
    chain = { ...OPEN, windowStart: NOW + 60 }
    renderLanding()
    expect(await screen.findByText("The crowdfund hasn't opened yet. Come back once it opens.")).toBeTruthy()
  })

  it('says the crowdfund has not opened yet while ARM is not loaded', async () => {
    chain = { ...OPEN, armLoaded: false }
    renderLanding()
    expect(await screen.findByText("The crowdfund hasn't opened yet. Come back once it opens.")).toBeTruthy()
  })

  it('says the crowdfund was cancelled when it is cancelled mid-window', async () => {
    chain = { ...OPEN, phase: 2 }
    renderLanding()
    expect(
      await screen.findByText('This crowdfund was cancelled, so no new commitments can be made.'),
    ).toBeTruthy()
  })

  it('still reports a passed deadline once the window has ended', async () => {
    chain = { ...OPEN, phase: 1, windowEnd: NOW - 60 }
    renderLanding()
    expect(await screen.findByText('The commitment deadline has passed.')).toBeTruthy()
  })
})
