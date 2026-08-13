// ABOUTME: Tests for DepositAmountCard's balance row — specifically the pendingBalance suffix that
// ABOUTME: surfaces not-yet-spendable ("pending") notes alongside the available balance.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DepositAmountCard } from './DepositAmountCard'

const CHAINS = [{ chainId: 31337, label: 'Hub' }]

function renderCard(props: Partial<Parameters<typeof DepositAmountCard>[0]> = {}) {
  return render(
    <DepositAmountCard
      chains={CHAINS}
      chainId={31337}
      amount=""
      onAmountChange={() => {}}
      balance="12.00"
      {...props}
    />,
  )
}

describe('DepositAmountCard — pendingBalance', () => {
  it('renders a "· X pending" suffix on the balance row when pendingBalance is set', () => {
    renderCard({ pendingBalance: '4.00' })
    // The suffix lives in the same balance span, so match the combined text.
    expect(screen.getByText(/12\.00 · 4\.00 pending/)).toBeInTheDocument()
  })

  it('shows only the available balance (no pending suffix) when pendingBalance is omitted', () => {
    renderCard()
    expect(screen.getByText('12.00')).toBeInTheDocument()
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument()
  })
})
