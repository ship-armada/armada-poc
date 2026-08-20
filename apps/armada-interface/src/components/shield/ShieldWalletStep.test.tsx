// ABOUTME: Tests for ShieldWalletStep — the title/subtitle transition + checklist render.
// ABOUTME: "Preparing…" while every row is pending (proof building); "Confirm in your wallet" once a prompt is live.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShieldWalletStep } from './ShieldWalletStep'
import type { WalletStep } from '@/lib/tx/shieldWalletSteps'

describe('ShieldWalletStep', () => {
  it('shows the "Preparing…" copy while every row is pending (proof building)', () => {
    const steps: WalletStep[] = [
      { label: 'Approve 5.00 USDC', status: 'pending' },
      { label: 'Submit 5.00 USDC deposit', status: 'pending' },
    ]
    render(<ShieldWalletStep steps={steps} />)
    expect(screen.getByRole('heading', { name: 'Preparing your deposit…' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Wallet confirmations' })).toBeInTheDocument()
    expect(screen.getByText('Submit 5.00 USDC deposit')).toBeInTheDocument()
  })

  it('switches to "Confirm in your wallet" once a prompt is live (a row is loading)', () => {
    const steps: WalletStep[] = [
      { label: 'Approve 5.00 USDC', status: 'loading' },
      { label: 'Submit 5.00 USDC deposit', status: 'pending' },
    ]
    render(<ShieldWalletStep steps={steps} />)
    expect(screen.getByRole('heading', { name: 'Confirm in your wallet' })).toBeInTheDocument()
  })
})
