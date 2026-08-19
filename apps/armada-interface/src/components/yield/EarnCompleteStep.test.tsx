// ABOUTME: Tests for EarnCompleteStep — title + summary rows adapt to add vs withdraw; explorer/dashboard CTAs.
// ABOUTME: The summary total row echoes the modal's per-tab netLabel/netAmount (not a blind amount + fee).

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EarnCompleteStep } from './EarnCompleteStep'
import type { YieldRate } from '@/hooks/useYieldRate'

const RATE: YieldRate = { rate: 1_000_000_000_000_000_000n, apyBps: 420n, fetchedAt: 0 }
const CONFIRMED_AT = 1_700_000_000_000

describe('<EarnCompleteStep>', () => {
  it("add tab: 'USDC deposit complete' title + Add-to-vault summary", () => {
    render(
      <EarnCompleteStep
        tab="add"
        amount={100_000_000n}
        rate={RATE}
        fee={1_000_000n}
        netAmount={101_000_000n}
        netLabel="Total deducted from balance"
        confirmedAt={CONFIRMED_AT}
        explorerUrl="https://example.test/tx/0xabc"
        onViewExplorer={() => {}}
        onGoToDashboard={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: 'USDC deposit complete' })).toBeInTheDocument()
    expect(screen.getByText('Add to vault')).toBeInTheDocument()
    expect(screen.getByText('Your deposit')).toBeInTheDocument()
    expect(screen.getByText('Total deducted from balance')).toBeInTheDocument()
  })

  it("withdraw tab: 'USDC withdrawal complete' title + Withdraw summary", () => {
    render(
      <EarnCompleteStep
        tab="withdraw"
        amount={50_000_000n}
        rate={RATE}
        fee={500_000n}
        netAmount={49_500_000n}
        netLabel="Received into private balance"
        confirmedAt={CONFIRMED_AT}
        onViewExplorer={() => {}}
        onGoToDashboard={() => {}}
      />,
    )
    expect(
      screen.getByRole('heading', { name: 'USDC withdrawal complete' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Withdraw from vault')).toBeInTheDocument()
    expect(screen.getByText('Your withdrawal')).toBeInTheDocument()
    // Past-tense on the confirmed screen (review says "You'll receive…"), net of the fee.
    expect(screen.getByText('Received into private balance')).toBeInTheDocument()
  })

  it('disables View on explorer when no explorerUrl is provided', () => {
    render(
      <EarnCompleteStep
        tab="add"
        amount={1_000_000n}
        rate={RATE}
        fee={0n}
        netAmount={1_000_000n}
        netLabel="Total deducted from balance"
        confirmedAt={CONFIRMED_AT}
        onViewExplorer={() => {}}
        onGoToDashboard={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'View on explorer' })).toBeDisabled()
  })

  it('fires onViewExplorer + onGoToDashboard on the CTAs', () => {
    const onViewExplorer = vi.fn()
    const onGoToDashboard = vi.fn()
    render(
      <EarnCompleteStep
        tab="add"
        amount={1_000_000n}
        rate={RATE}
        fee={0n}
        netAmount={1_000_000n}
        netLabel="Total deducted from balance"
        confirmedAt={CONFIRMED_AT}
        explorerUrl="https://example.test/tx/0xabc"
        onViewExplorer={onViewExplorer}
        onGoToDashboard={onGoToDashboard}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'View on explorer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go to dashboard' }))
    expect(onViewExplorer).toHaveBeenCalledTimes(1)
    expect(onGoToDashboard).toHaveBeenCalledTimes(1)
  })
})
