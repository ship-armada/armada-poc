// ABOUTME: Tests for EarnReviewStep — headline + mode + APY copy + dispatch Back/Confirm.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EarnReviewStep } from './EarnReviewStep'

function setupAdd() {
  const onBack = vi.fn()
  const onConfirm = vi.fn()
  render(
    <EarnReviewStep
      tab="add"
      amount={100_000_000n}
      rate={null}
      fee={null}
      netAmount={100_000_000n}
      netLabel="Total deducted from balance"
      onBack={onBack}
      onConfirm={onConfirm}
    />,
  )
  return { onBack, onConfirm }
}

describe('<EarnReviewStep>', () => {
  it("tab=add: title 'Review your USDC deposit' and mode 'Add to vault'", () => {
    setupAdd()
    expect(screen.getByRole('heading', { name: 'Review your USDC deposit' })).toBeInTheDocument()
    expect(screen.getByText('Add to vault')).toBeInTheDocument()
  })

  it("tab=withdraw: title 'Review your USDC withdrawal' and mode 'Withdraw from vault'", () => {
    render(
      <EarnReviewStep
        tab="withdraw"
        amount={50_000_000n}
        rate={null}
        fee={null}
        netAmount={49_500_000n}
        netLabel="You'll receive into private balance"
        onBack={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Review your USDC withdrawal' })).toBeInTheDocument()
    expect(screen.getByText('Withdraw from shielded vault')).toBeInTheDocument()
  })

  it('APY shows syncing copy when rate is null', () => {
    setupAdd()
    expect(screen.getByText('syncing…')).toBeInTheDocument()
  })

  it('fires onConfirm with the right label for the add tab', () => {
    const { onConfirm } = setupAdd()
    fireEvent.click(screen.getByRole('button', { name: /Confirm deposit/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onBack', () => {
    const { onBack } = setupAdd()
    fireEvent.click(screen.getByRole('button', { name: /^Back/ }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
