// ABOUTME: Tests for the admin FinalizePanel under the relaunch profile (mocked), which has no elastic expansion:
// ABOUTME: no elastic-trigger row or EXPANDED/BASE labels, the $250K minimum, and the launch-team payment split.

import { render, screen } from '@testing-library/react'
import type { HopAllocationStats } from '@armada/crowdfund-shared'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return {
    ...actual,
    CROWDFUND_CONSTANTS: actual.CONSTANTS_BY_PROFILE.relaunch,
    HOP_CONFIGS: actual.HOP_CONFIGS_BY_PROFILE.relaunch,
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

import { FinalizePanel } from './FinalizePanel'

const K = 1_000n * 10n ** 6n
const stats = (h0: bigint, h2: bigint): HopAllocationStats[] => [
  { cappedCommitted: h0 * K },
  { cappedCommitted: 0n },
  { cappedCommitted: h2 * K },
]

function renderPanel(h0: bigint, h2: bigint) {
  render(
    <FinalizePanel
      signer={null}
      crowdfundAddress="0x1234"
      totalCommitted={(h0 + h2) * K}
      saleSize={0n}
      cappedDemand={(h0 + h2) * K}
      hopStats={stats(h0, h2)}
    />,
  )
}

describe('FinalizePanel on the relaunch profile', () => {
  // WHY: BASE_SALE == MAX_SALE, so "Met (EXPANDED)" would claim an expansion that changes nothing.
  it('drops the elastic-trigger row and the expansion labels', () => {
    renderPanel(1_500n, 0n)
    expect(screen.queryByText(/Elastic trigger/)).toBeNull()
    expect(screen.queryByText(/EXPANDED|BASE/)).toBeNull()
  })

  // WHY: the relaunch minimum is $250K of capped demand; the panel must judge against it.
  it('meets the minimum at $250K and not below', () => {
    renderPanel(200n, 50n)
    expect(screen.getByText('✓ Met')).toBeInTheDocument()
  })

  // WHY: finalize pays the launch team $250K before the treasury, so the operator must see the
  // projected split, including at the minimum, where the treasury receives nothing.
  it('projects the $250K launch-team payment and the treasury remainder', () => {
    renderPanel(1_000n, 0n)
    expect(screen.getByText('Launch team payment:').parentElement?.textContent).toContain('$250,000')
    expect(screen.getByText('Treasury:').parentElement?.textContent).toContain('$750,000')
  })

  it('projects the whole minimum raise to the launch team', () => {
    renderPanel(200n, 50n)
    expect(screen.getByText('Launch team payment:').parentElement?.textContent).toContain('$250,000')
    expect(screen.getByText('Treasury:').parentElement?.textContent).toContain('$0')
  })
})
