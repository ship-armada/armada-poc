// ABOUTME: Tests for FinalizePanel component — pre-finalization summary and checks.
// ABOUTME: Verifies demand checks, expected outcome display, and refund-mode warning.

import { render, screen } from '@testing-library/react'
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

describe('FinalizePanel', () => {
  it('shows ✓ Met when above MIN_SALE', () => {
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={1_200_000n * 10n ** 6n}
        saleSize={1_200_000n * 10n ** 6n}
        cappedDemand={1_200_000n * 10n ** 6n}
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
      />,
    )
    expect(screen.getByText(/refund mode/i)).toBeInTheDocument()
  })

  it('shows elastic trigger status', () => {
    render(
      <FinalizePanel
        signer={null}
        crowdfundAddress="0x1234"
        totalCommitted={1_600_000n * 10n ** 6n}
        saleSize={1_800_000n * 10n ** 6n}
        cappedDemand={1_600_000n * 10n ** 6n}
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
      />,
    )
    expect(screen.getByText(/expected outcome/i)).toBeInTheDocument()
    // BASE appears in both elastic trigger status and expected outcome
    const baseTexts = screen.getAllByText(/BASE/)
    expect(baseTexts.length).toBeGreaterThanOrEqual(1)
  })
})
