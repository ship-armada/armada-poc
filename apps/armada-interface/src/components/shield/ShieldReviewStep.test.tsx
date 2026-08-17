// ABOUTME: Tests for ShieldReviewStep — renders amount + chain name + dispatches Back/Confirm.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ShieldReviewStep } from './ShieldReviewStep'

function setup() {
  const onBack = vi.fn()
  const onConfirm = vi.fn()
  render(
    <ShieldReviewStep
      fromChainId={31337}
      amount={100_500_000n}
      fee={null}
      netAmount={100_500_000n}
      onBack={onBack}
      onConfirm={onConfirm}
    />,
  )
  return { onBack, onConfirm }
}

describe('<ShieldReviewStep>', () => {
  it('renders the amount and chain name', () => {
    setup()
    // Amount renders full-precision in the coin+amount block ("100.5") and 2dp in the summary
    // "Deposit amount" row ("100.50 USDC"); a regex resolves either. Chain name is the Network row.
    expect(screen.getAllByText(/100\.5/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Anvil Hub/)).toBeInTheDocument()
  })

  it('fires onConfirm on the primary CTA', () => {
    const { onConfirm } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Confirm deposit/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onBack on the secondary CTA', () => {
    const { onBack } = setup()
    fireEvent.click(screen.getByRole('button', { name: /^Back/ }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
