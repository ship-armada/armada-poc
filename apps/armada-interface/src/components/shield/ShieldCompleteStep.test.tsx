// ABOUTME: Tests for ShieldCompleteStep — renders the confirmed headline, the deposited amount, the date/time row, and dispatches the explorer/dashboard CTAs.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ShieldCompleteStep } from './ShieldCompleteStep'

function setup(overrides?: { explorerUrl?: string }) {
  const onViewExplorer = vi.fn()
  const onGoToDashboard = vi.fn()
  render(
    <ShieldCompleteStep
      fromChainId={31337}
      amount={250_500_000n}
      fee={null}
      netAmount={250_500_000n}
      confirmedAt={Date.parse('2026-01-05T15:42:00Z')}
      explorerUrl={'explorerUrl' in (overrides ?? {}) ? overrides?.explorerUrl : 'https://example.com/tx/0xabc'}
      onViewExplorer={onViewExplorer}
      onGoToDashboard={onGoToDashboard}
    />,
  )
  return { onViewExplorer, onGoToDashboard }
}

describe('<ShieldCompleteStep>', () => {
  it('renders the headline, the amount in the coin+amount block, and the chain name', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'USDC deposit confirmed' })).toBeInTheDocument()
    // Gross amount renders full-precision in the coin block; net amount ("250.50 USDC") is the
    // summary Total row, a distinct node — so the exact-text query still resolves the block.
    expect(screen.getByText('250.5')).toBeInTheDocument()
    expect(screen.getByText(/Anvil Hub/)).toBeInTheDocument()
  })

  it('fires onGoToDashboard when the primary CTA is clicked', () => {
    const { onGoToDashboard } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Go to dashboard/ }))
    expect(onGoToDashboard).toHaveBeenCalledTimes(1)
  })

  it('fires onViewExplorer when the secondary CTA is clicked', () => {
    const { onViewExplorer } = setup()
    fireEvent.click(screen.getByRole('button', { name: /View on explorer/ }))
    expect(onViewExplorer).toHaveBeenCalledTimes(1)
  })

  it('disables the explorer CTA when no explorerUrl is provided', () => {
    setup({ explorerUrl: undefined })
    expect(screen.getByRole('button', { name: /View on explorer/ })).toBeDisabled()
  })
})
