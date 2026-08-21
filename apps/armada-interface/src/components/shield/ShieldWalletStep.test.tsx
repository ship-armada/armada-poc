// ABOUTME: Tests for ShieldWalletStep — the title/subtitle transition + checklist render.
// ABOUTME: "Preparing…" while every row is pending (proof building); "Confirm in your wallet" once a prompt is live.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShieldWalletStep } from './ShieldWalletStep'
import type { WalletStep } from '@/lib/tx/shieldWalletSteps'

describe('ShieldWalletStep', () => {
  it('renders the checklist under the mockup title, with the "Preparing…" footer while pending', () => {
    const steps: WalletStep[] = [
      { label: 'Approve 5.00 USDC', status: 'pending' },
      { label: 'Sign shield transaction', status: 'pending' },
    ]
    render(<ShieldWalletStep steps={steps} />)
    expect(
      screen.getByRole('heading', { name: 'Confirm transactions on your wallet' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Wallet confirmations' })).toBeInTheDocument()
    expect(screen.getByText('Sign shield transaction')).toBeInTheDocument()
    // Proof still building → honest "preparing" footer (no prompt live yet).
    expect(screen.getByText('Preparing your shield…')).toBeInTheDocument()
  })

  it('switches the footer to "Waiting for wallet confirmation" once a prompt is live', () => {
    const steps: WalletStep[] = [
      { label: 'Approve 5.00 USDC', status: 'loading' },
      { label: 'Sign shield transaction', status: 'pending' },
    ]
    render(<ShieldWalletStep steps={steps} />)
    expect(screen.getByText('Waiting for wallet confirmation')).toBeInTheDocument()
  })
})
