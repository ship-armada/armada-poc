// ABOUTME: Tests for FeeSummary — loading state, formatted fee + net amount, custom labels, refresh hint.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FeeSummary } from './FeeSummary'

describe('<FeeSummary>', () => {
  it('renders loading copy when fee is null', () => {
    render(<FeeSummary fee={null} netAmount={100_000_000n} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders the formatted fee and net amount when fee is present', () => {
    render(<FeeSummary fee={250_000n} netAmount={99_750_000n} />)
    expect(screen.getByText(/0\.25/)).toBeInTheDocument()
    expect(screen.getByText(/99\.75/)).toBeInTheDocument()
  })

  it('renders the default labels', () => {
    render(<FeeSummary fee={0n} netAmount={0n} />)
    expect(screen.getByText('Estimated fee')).toBeInTheDocument()
    expect(screen.getByText("You'll receive")).toBeInTheDocument()
  })

  it('honors custom labels', () => {
    render(
      <FeeSummary
        fee={0n}
        netAmount={0n}
        feeLabel="Protocol fee"
        netLabel="You'll deposit"
      />,
    )
    expect(screen.getByText('Protocol fee')).toBeInTheDocument()
    expect(screen.getByText("You'll deposit")).toBeInTheDocument()
  })

  it('shows the refresh hint only when fee is non-null, non-zero, and isRefreshing is true', () => {
    const { rerender } = render(<FeeSummary fee={null} netAmount={0n} isRefreshing />)
    expect(screen.queryByText(/refreshing/)).toBeNull() // null fee → loading wins
    rerender(<FeeSummary fee={0n} netAmount={0n} isRefreshing />)
    expect(screen.queryByText(/refreshing/)).toBeNull() // zero fee → "No fee" wins; refresh hint is irrelevant
    rerender(<FeeSummary fee={1_000n} netAmount={0n} isRefreshing />)
    expect(screen.getByText(/refreshing/)).toBeInTheDocument()
  })

  it('renders "No fee" instead of a 0.00 USDC line when fee is exactly zero', () => {
    // Many of today's flows (shield, unshield-local, transfer-shielded, yield ops) charge no
    // USDC fee — the user pays gas in native via their wallet. "No fee" reads cleaner than
    // "Fee: 0.00 USDC", which suggests a fee is being computed but happens to round to zero.
    render(<FeeSummary fee={0n} netAmount={100_000_000n} />)
    expect(screen.getByText('No fee')).toBeInTheDocument()
    expect(screen.queryByText(/0\.00 USDC/)).toBeNull()
  })

  it('renders "<0.01" for a non-zero fee that rounds below the 2dp display threshold', () => {
    // WHY: the CCTP fast-fee on a small xchain unshield is sub-cent (2 bps of $5 = 0.001 USDC).
    // `formatUsdcAmount` clamps to 2 decimals and would render that as "0.00 USDC" —
    // indistinguishable from "No fee" even though the fee IS deducted from the destination mint
    // on chain. The "<0.01" surface tells the user "yes there's a fee, just very small" without
    // changing the recipient-receives math.
    render(<FeeSummary fee={1_000n} netAmount={99_999_000n} />)
    expect(screen.getByText(/<0\.01/)).toBeInTheDocument()
    expect(screen.queryByText('No fee')).toBeNull()
  })

  it('applies the "<0.01" rule to the secondary fee row too (A5 xchain CCTP slot)', () => {
    // WHY: the secondary row exists specifically for unshield-xchain, where the CCTP fast-fee is
    // proportional to amount and the most common amounts in testing surface as sub-cent. Both
    // rows must use the same formatter so the user sees consistent semantics across the panel.
    render(
      <FeeSummary
        fee={100_000n}
        secondaryFee={1_000n}
        secondaryFeeLabel="CCTP delivery fee"
        netAmount={50_000_000n}
      />,
    )
    // Primary row renders normally; secondary row uses the sub-cent surface.
    expect(screen.getByText(/0\.10/)).toBeInTheDocument()
    expect(screen.getByText(/<0\.01/)).toBeInTheDocument()
  })
})
