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
      totalDeducted={100_000_000n}
      onBack={onBack}
      onConfirm={onConfirm}
    />,
  )
  return { onBack, onConfirm }
}

describe('<EarnReviewStep>', () => {
  it("tab=add: headline 'Review deposit' and mode 'Add to vault'", () => {
    setupAdd()
    expect(screen.getByText('Review deposit')).toBeInTheDocument()
    expect(screen.getByText('Add to vault')).toBeInTheDocument()
  })

  it("tab=withdraw: headline 'Review withdrawal' and mode 'Withdraw from vault'", () => {
    render(
      <EarnReviewStep
        tab="withdraw"
        amount={50_000_000n}
        rate={null}
        fee={null}
        totalDeducted={50_000_000n}
        onBack={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText('Review withdrawal')).toBeInTheDocument()
    expect(screen.getByText('Withdraw from vault')).toBeInTheDocument()
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
