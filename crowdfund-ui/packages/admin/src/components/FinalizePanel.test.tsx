// ABOUTME: Tests for FinalizePanel component — pre-finalization summary and checks.
// ABOUTME: Verifies demand checks, expected outcome display, and refund-mode warning.

import { render, screen } from '@testing-library/react'
import type { HopAllocationStats } from '@armada/crowdfund-shared'
import { FinalizePanel } from './FinalizePanel'

vi.mock('@/hooks/useTransactionFlow', () => ({
  useTransactionFlow: () => ({
    state: { status: 'idle', txHash: null, receipt: null, error: null },
    execute: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock('./TransactionFlow', () => ({
  TransactionFlow: () => null,
}))

const K = 1_000n * 10n ** 6n

/** Per-hop capped demand, in thousands of USDC. */
function hopStats(hop0: bigint, hop1: bigint, hop2: bigint): HopAllocationStats[] {
  return [{ cappedCommitted: hop0 * K }, { cappedCommitted: hop1 * K }, { cappedCommitted: hop2 * K }]
}

describe('FinalizePanel', () => {
  it('shows ✓ Met when above MIN_SALE', () => {
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={1_200_000n * 10n ** 6n}
        saleSize={1_200_000n * 10n ** 6n}
        cappedDemand={1_200_000n * 10n ** 6n}
        hopStats={hopStats(500n, 450n, 250n)}
      />,
    )
    expect(screen.getByText('✓ Met')).toBeInTheDocument()
  })

  it('shows ✗ Not met when below MIN_SALE', () => {
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={500_000n * 10n ** 6n}
        saleSize={1_200_000n * 10n ** 6n}
        cappedDemand={500_000n * 10n ** 6n}
        hopStats={hopStats(300n, 150n, 50n)}
      />,
    )
    expect(screen.getByText('✗ Not met')).toBeInTheDocument()
  })

  it('shows refund mode warning when below min', () => {
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={500_000n * 10n ** 6n}
        saleSize={1_200_000n * 10n ** 6n}
        cappedDemand={500_000n * 10n ** 6n}
        hopStats={hopStats(300n, 150n, 50n)}
      />,
    )
    expect(
      screen.getByText(/Projected allocation is below the minimum fund/),
    ).toBeInTheDocument()
  })

  it('projects refund mode when hop-0-heavy capped demand clears MIN_SALE but allocates below it', () => {
    // WHY: finalize() refunds on post-waterfall allocation, not capped demand. $1.05M capped
    // with $900k at hop-0 allocates only $564k + $100k + $50k = $714k → refund mode.
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={1_050_000n * 10n ** 6n}
        saleSize={0n}
        cappedDemand={1_050_000n * 10n ** 6n}
        hopStats={hopStats(900n, 100n, 50n)}
      />,
    )
    expect(screen.getByText('✗ Not met')).toBeInTheDocument()
    expect(screen.getByText(/Projected allocation is below the minimum fund/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Finalize (Refund Mode)' })).toBeInTheDocument()
    expect(screen.queryByText(/expected outcome/i)).not.toBeInTheDocument()
  })

  it('shows the projected allocation alongside capped demand', () => {
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={1_050_000n * 10n ** 6n}
        saleSize={0n}
        cappedDemand={1_050_000n * 10n ** 6n}
        hopStats={hopStats(900n, 100n, 50n)}
      />,
    )
    expect(screen.getByText(/Projected allocation:/)).toHaveTextContent('714,000')
  })

  it('shows elastic trigger status', () => {
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={1_600_000n * 10n ** 6n}
        saleSize={1_800_000n * 10n ** 6n}
        cappedDemand={1_600_000n * 10n ** 6n}
        hopStats={hopStats(800n, 500n, 300n)}
      />,
    )
    expect(screen.getByText(/✓ Met \(EXPANDED\)/)).toBeInTheDocument()
  })

  it('shows expected outcome when above min', () => {
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={1_200_000n * 10n ** 6n}
        saleSize={1_200_000n * 10n ** 6n}
        cappedDemand={1_200_000n * 10n ** 6n}
        hopStats={hopStats(500n, 450n, 250n)}
      />,
    )
    expect(screen.getByText(/expected outcome/i)).toBeInTheDocument()
    // BASE appears in both elastic trigger status and expected outcome
    const baseTexts = screen.getAllByText(/BASE/)
    expect(baseTexts.length).toBeGreaterThanOrEqual(1)
  })

  it('estimates net proceeds and refunds from the projected allocation', () => {
    // $1.1M capped: hop-0 $600k is cut to its $564k ceiling, so $1,064k is allocated
    // and the $36k hop-0 excess is refunded.
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={1_100_000n * 10n ** 6n}
        saleSize={0n}
        cappedDemand={1_100_000n * 10n ** 6n}
        hopStats={hopStats(600n, 300n, 200n)}
      />,
    )
    expect(screen.getByText(/Net proceeds:/)).toHaveTextContent('1,064,000')
    expect(screen.getByText(/Refunds:/)).toHaveTextContent('36,000')
  })
})
