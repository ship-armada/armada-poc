// ABOUTME: Regression tests for Step2Commit's MIN_COMMIT gating.
// ABOUTME: A non-zero amount below the per-commit minimum must block Review.
// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Step2Commit from './Step2Commit.js'

// Shared tests resolve the default (mainnet) profile → MIN_COMMIT = $10.
const MIN = 10

function renderSingle() {
  render(
    <Step2Commit
      onNext={vi.fn()}
      onBack={vi.fn()}
      maxAmount={4000}
      availableBalance={1000}
    />,
  )
  return {
    input: screen.getByRole('textbox'),
    review: () => screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement,
  }
}

describe('Step2Commit MIN_COMMIT gate (single hop)', () => {
  it('disables Review for a non-zero amount below the minimum', () => {
    const { input, review } = renderSingle()
    fireEvent.change(input, { target: { value: String(MIN - 5) } })
    expect(review().disabled).toBe(true)
    expect(screen.getByText(/Minimum .* USDC per commit/)).toBeTruthy()
  })

  it('enables Review at the minimum', () => {
    const { input, review } = renderSingle()
    fireEvent.change(input, { target: { value: String(MIN) } })
    expect(review().disabled).toBe(false)
  })

  it('disables Review at zero', () => {
    const { review } = renderSingle()
    expect(review().disabled).toBe(true)
  })
})

describe('Step2Commit fully-committed state (single hop)', () => {
  it('shows a max-committed message instead of the input when the cap is reached', () => {
    render(
      <Step2Commit
        onNext={vi.fn()}
        onBack={vi.fn()}
        maxAmount={4000}
        existingCommittedUsdc={4000}
        availableBalance={1000}
      />,
    )
    expect(screen.getByText(/fully committed/i)).toBeTruthy()
    expect(screen.getByText(/committed the maximum/i)).toBeTruthy()
    // No amount input and no Review button in this state.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
  })

  it('still renders the input when capacity remains', () => {
    render(
      <Step2Commit
        onNext={vi.fn()}
        onBack={vi.fn()}
        maxAmount={4000}
        existingCommittedUsdc={1000}
        availableBalance={1000}
      />,
    )
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(screen.queryByText(/fully committed/i)).toBeNull()
  })
})
