// ABOUTME: Regression tests for Step2Commit's MIN_COMMIT gating.
// ABOUTME: A non-zero amount below the per-commit minimum must block Review (aria-disabled, primary look).
// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Step2Commit from './Step2Commit.js'

// Shared tests resolve the default (mainnet) profile → MIN_COMMIT = $50.
const MIN = 50

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
        screen.getByRole('button', { name: 'Input amount' })) as HTMLButtonElement,
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

  it('shows Input amount at zero with aria-disabled', () => {
    const { primary } = renderSingle()
    const btn = primary()
    expect(btn.textContent).toContain('Input amount')
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

describe('Step2Commit empty-amount CTA (multi hop)', () => {
  it('shows Input amount until an amount is entered', () => {
    render(
      <Step2Commit
        onNext={vi.fn()}
        onBack={vi.fn()}
        availableBalance={1000}
        hopRows={[
          { hop: 0, hopLabel: 'HOP-0', hopColor: '#fff', maxAmount: 4000, existingCommittedUsdc: 0 },
          { hop: 1, hopLabel: 'HOP-1', hopColor: '#fff', maxAmount: 1000, existingCommittedUsdc: 0 },
        ]}
      />,
    )
    const btn = screen.getByRole('button', { name: 'Input amount' })
    expect(btn.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('Step2Commit hop label (single hop)', () => {
  it('names the hop under the fill bar, not in a badge above the input', () => {
    render(
      <Step2Commit
        onNext={vi.fn()}
        onBack={vi.fn()}
        maxAmount={4000}
        availableBalance={1000}
        hopLabel="HOP-0"
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '100' } })

    expect(screen.getByText('HOP-0 commit')).toBeTruthy()
    expect(screen.queryByText('HOP-0')).toBeNull()
    // The running total no longer sits under the bar.
    expect(screen.queryByText('100 USDC')).toBeNull()
  })

  it('names the hop in the fully-committed message instead of a badge', () => {
    render(
      <Step2Commit
        onNext={vi.fn()}
        onBack={vi.fn()}
        maxAmount={4000}
        existingCommittedUsdc={4000}
        availableBalance={1000}
        hopLabel="HOP-0"
      />,
    )
    expect(screen.queryByText('HOP-0')).toBeNull()
    expect(screen.getByText(/committed the maximum 4,000 USDC for HOP-0\./)).toBeTruthy()
  })
})

