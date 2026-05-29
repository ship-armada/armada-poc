// ABOUTME: Tests for UnshieldCompleteStep — renders success copy with formatted amount + truncated recipient + chain name; Done dispatches onDone.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UnshieldCompleteStep } from './UnshieldCompleteStep'

const VALID_ADDR = '0xabcdef1234567890abcdef1234567890abcdef12'

describe('<UnshieldCompleteStep>', () => {
  it('renders the headline and the success body copy', () => {
    render(
      <UnshieldCompleteStep
        destChainId={31337}
        recipient={VALID_ADDR}
        recipientReceives={250_500_000n}
        totalDeducted={250_500_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Withdrawal complete' })).toBeInTheDocument()
    expect(screen.getByText(/250\.50 USDC/)).toBeInTheDocument()
    expect(screen.getByText(/0xabcd\.{3}ef12/)).toBeInTheDocument()
    expect(screen.getByText(/Anvil Hub/)).toBeInTheDocument()
  })

  it('renders the "Total deducted" line when total exceeds recipient-receives (local-relayer path)', () => {
    // WHY: the load-bearing UX promise of A3 — that the user sees BOTH "you sent X" and "we
    // deducted Y" so they understand where the relayer fee went. A regression that dropped this
    // line would silently make every unshield-local look like a free transfer.
    render(
      <UnshieldCompleteStep
        destChainId={31337}
        recipient={VALID_ADDR}
        recipientReceives={5_000_000n}
        totalDeducted={6_220_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.getByText(/Sent 5\.00 USDC/)).toBeInTheDocument()
    expect(screen.getByText(/Total deducted.*6\.22 USDC/)).toBeInTheDocument()
  })

  it('renders the explorer link only when explorerUrl is provided', () => {
    // WHY: local Anvil has no explorer (txExplorerUrl returns undefined). The link must hide
    // silently rather than rendering a broken href that 404s.
    const { rerender } = render(
      <UnshieldCompleteStep
        destChainId={31337}
        recipient={VALID_ADDR}
        recipientReceives={5_000_000n}
        totalDeducted={5_000_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.queryByRole('link', { name: /View transaction/ })).toBeNull()
    rerender(
      <UnshieldCompleteStep
        destChainId={31337}
        recipient={VALID_ADDR}
        recipientReceives={5_000_000n}
        totalDeducted={5_000_000n}
        explorerUrl="https://sepolia.etherscan.io/tx/0xdeadbeef"
        onDone={() => {}}
      />,
    )
    const link = screen.getByRole('link', { name: /View transaction/ })
    expect(link).toHaveAttribute('href', 'https://sepolia.etherscan.io/tx/0xdeadbeef')
  })

  it('fires onDone when the Done CTA is clicked', () => {
    const onDone = vi.fn()
    render(
      <UnshieldCompleteStep
        destChainId={31337}
        recipient={VALID_ADDR}
        recipientReceives={1_000_000n}
        totalDeducted={1_000_000n}
        onDone={onDone}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Done/ }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
