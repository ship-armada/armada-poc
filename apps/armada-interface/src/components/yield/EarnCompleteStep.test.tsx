// ABOUTME: Tests for EarnCompleteStep — title + body copy adapts to add vs withdraw, second line + explorer link render conditionally.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EarnCompleteStep } from './EarnCompleteStep'

describe('<EarnCompleteStep>', () => {
  it("add tab: 'Earning' headline + matching body copy", () => {
    render(
      <EarnCompleteStep
        tab="add"
        recipientReceives={100_000_000n}
        totalDeducted={100_000_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Earning' })).toBeInTheDocument()
    expect(screen.getByText(/earning yield on 100\.00 USDC/)).toBeInTheDocument()
  })

  it("withdraw tab: 'Withdrawn from vault' headline + matching body", () => {
    render(
      <EarnCompleteStep
        tab="withdraw"
        recipientReceives={50_000_000n}
        totalDeducted={50_000_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Withdrawn from vault' })).toBeInTheDocument()
    expect(screen.getByText(/Returned 50\.00 USDC/)).toBeInTheDocument()
  })

  it("shows the 'Total deducted' second line when totalDeducted > recipientReceives", () => {
    render(
      <EarnCompleteStep
        tab="add"
        recipientReceives={100_000_000n}
        totalDeducted={101_000_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.getByText(/Total deducted from your private balance: 101\.00 USDC/)).toBeInTheDocument()
  })

  it('hides the second line when totalDeducted equals recipientReceives', () => {
    render(
      <EarnCompleteStep
        tab="add"
        recipientReceives={100_000_000n}
        totalDeducted={100_000_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.queryByText(/Total deducted from your private balance/)).not.toBeInTheDocument()
  })

  it('renders the explorer link when explorerUrl is provided', () => {
    render(
      <EarnCompleteStep
        tab="add"
        recipientReceives={1_000_000n}
        totalDeducted={1_010_000n}
        explorerUrl="https://example.test/tx/0xabc"
        onDone={() => {}}
      />,
    )
    const link = screen.getByRole('link', { name: /View transaction/ })
    expect(link).toHaveAttribute('href', 'https://example.test/tx/0xabc')
  })

  it('fires onDone on the CTA', () => {
    const onDone = vi.fn()
    render(
      <EarnCompleteStep
        tab="add"
        recipientReceives={1_000_000n}
        totalDeducted={1_000_000n}
        onDone={onDone}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Done/ }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
