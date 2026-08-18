// ABOUTME: Tests for EarnReviewSummary — per-tab mode/amount labels, APY row, fee "—" placeholder, and the per-tab net total row.
// ABOUTME: The total row echoes the caller's netLabel/netAmount (deposit debit vs withdraw net gain), never a blind amount + fee.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EarnReviewSummary } from './EarnReviewSummary'
import type { YieldRate } from '@/hooks/useYieldRate'

const RATE: YieldRate = { rate: 1_000_000_000_000_000_000n, apyBps: 450n, fetchedAt: 0 }

describe('<EarnReviewSummary>', () => {
  it('add tab: Mode "Add to vault", "Your deposit", and the deposit-debit total', () => {
    render(
      <EarnReviewSummary
        tab="add"
        amount={100_000_000n}
        rate={RATE}
        fee={1_000_000n}
        netAmount={101_000_000n}
        netLabel="Total deducted from balance"
      />,
    )
    expect(screen.getByText('Add to vault')).toBeInTheDocument()
    expect(screen.getByText('Your deposit')).toBeInTheDocument()
    expect(screen.getByText('~4.50%')).toBeInTheDocument()
    expect(screen.getByText('Total deducted from balance')).toBeInTheDocument()
    expect(screen.getByText('101.00 USDC')).toBeInTheDocument()
  })

  it('withdraw tab: Mode "Withdraw from vault", "Your withdrawal", and the net-gain total', () => {
    render(
      <EarnReviewSummary
        tab="withdraw"
        amount={50_000_000n}
        rate={RATE}
        fee={500_000n}
        netAmount={50_000_000n}
        netLabel="You'll receive into private balance"
      />,
    )
    expect(screen.getByText('Withdraw from vault')).toBeInTheDocument()
    expect(screen.getByText('Your withdrawal')).toBeInTheDocument()
    expect(screen.getByText("You'll receive into private balance")).toBeInTheDocument()
  })

  it('renders "—" for the fee before a quote loads (fee=null)', () => {
    render(
      <EarnReviewSummary
        tab="add"
        amount={100_000_000n}
        rate={RATE}
        fee={null}
        netAmount={100_000_000n}
        netLabel="Total deducted from balance"
      />,
    )
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows the syncing APY copy when rate is null', () => {
    render(
      <EarnReviewSummary
        tab="add"
        amount={100_000_000n}
        rate={null}
        fee={0n}
        netAmount={100_000_000n}
        netLabel="Total deducted from balance"
      />,
    )
    expect(screen.getByText('syncing…')).toBeInTheDocument()
  })

  it('adds a "Date and time" row when confirmedAt is set', () => {
    render(
      <EarnReviewSummary
        tab="add"
        amount={100_000_000n}
        rate={RATE}
        fee={0n}
        netAmount={100_000_000n}
        netLabel="Total deducted from balance"
        confirmedAt={1_700_000_000_000}
      />,
    )
    expect(screen.getByText('Date and time')).toBeInTheDocument()
  })
})
