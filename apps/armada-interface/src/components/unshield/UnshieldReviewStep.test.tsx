// ABOUTME: Tests for UnshieldReviewStep — renders amount, destination chain, truncated recipient, cross-chain tag, and dispatches Back/Confirm.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UnshieldReviewStep } from './UnshieldReviewStep'

const VALID_ADDR = '0x1234567890abcdef1234567890abcdef12345678'

function setup(opts?: { isXchain?: boolean; destChainId?: number }) {
  const onBack = vi.fn()
  const onConfirm = vi.fn()
  render(
    <UnshieldReviewStep
      destChainId={opts?.destChainId ?? 31337}
      recipient={VALID_ADDR}
      amount={50_000_000n}
      fee={null}
      cctpFee={0n}
      totalDeducted={50_000_000n}
      isXchain={opts?.isXchain ?? false}
      onBack={onBack}
      onConfirm={onConfirm}
    />,
  )
  return { onBack, onConfirm }
}

describe('<UnshieldReviewStep>', () => {
  it('renders the amount + destination + truncated recipient', () => {
    setup()
    expect(screen.getAllByText('50.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Anvil Hub/)).toBeInTheDocument()
    expect(screen.getByText('0x1234...5678')).toBeInTheDocument()
  })

  it('omits the cross-chain tag for local withdrawals', () => {
    setup({ isXchain: false })
    expect(screen.queryByText('cross-chain')).toBeNull()
  })

  it('renders the cross-chain tag for xchain withdrawals', () => {
    setup({ isXchain: true, destChainId: 31338 })
    expect(screen.getByText('cross-chain')).toBeInTheDocument()
  })

  it('fires onConfirm on the primary CTA', () => {
    const { onConfirm } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Confirm withdrawal/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onBack on the secondary CTA', () => {
    const { onBack } = setup()
    fireEvent.click(screen.getByRole('button', { name: /^Back/ }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
