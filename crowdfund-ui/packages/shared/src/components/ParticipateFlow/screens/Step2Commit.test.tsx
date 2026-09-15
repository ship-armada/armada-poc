// ABOUTME: Regression tests for Step2Commit's MIN_COMMIT gating.
// ABOUTME: A non-zero amount below the per-commit minimum must block Review (aria-disabled, primary look).
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
    primary: () =>
      (screen.queryByRole('button', { name: 'Review' }) ??
        screen.getByRole('button', { name: 'Insert amount' })) as HTMLButtonElement,
  }
}

describe('Step2Commit MIN_COMMIT gate (single hop)', () => {
  it('blocks Review for a non-zero amount below the minimum without muted disabled styles', () => {
    const { input, primary } = renderSingle()
    fireEvent.change(input, { target: { value: String(MIN - 5) } })
    const btn = primary()
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(btn.textContent).toContain('Review')
    expect(screen.getByText(/Minimum .* USDC per commit/)).toBeTruthy()
  })

  it('allows Review at the minimum', () => {
    const { input, primary } = renderSingle()
    fireEvent.change(input, { target: { value: String(MIN) } })
    const btn = primary()
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-disabled')).toBeNull()
    expect(btn.textContent).toContain('Review')
  })

  it('shows Insert amount at zero with aria-disabled', () => {
    const { primary } = renderSingle()
    const btn = primary()
    expect(btn.textContent).toContain('Insert amount')
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
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
