// ABOUTME: Tests for EarnInputStep — tab switching, amount validation against tab-specific max, APY copy in each rate state.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EarnInputStep, type EarnTab } from './EarnInputStep'
import type { YieldRate } from '@/hooks/useYieldRate'

function setup(extras?: {
  tab?: EarnTab
  amountStr?: string
  max?: bigint
  rate?: YieldRate | null
}) {
  const props = {
    tab: extras?.tab ?? 'add' as EarnTab,
    onTabChange: vi.fn(),
    amountStr: extras?.amountStr ?? '',
    onAmountChange: vi.fn(),
    max: extras?.max ?? 5_000_000n,
    rate: extras?.rate ?? null as YieldRate | null,
    fee: null as bigint | null,
    totalDeducted: 0n,
    onCancel: vi.fn(),
    onContinue: vi.fn(),
  }
  render(<EarnInputStep {...props} />)
  return props
}

describe('<EarnInputStep>', () => {
  it('renders Add funds and Withdraw tabs', () => {
    setup()
    expect(screen.getByRole('tab', { name: 'Add funds' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Withdraw' })).toBeInTheDocument()
  })

  it('uses the add label when tab=add', () => {
    setup({ tab: 'add' })
    expect(screen.getByLabelText('How much to add?')).toBeInTheDocument()
  })

  it('uses the withdraw label when tab=withdraw', () => {
    setup({ tab: 'withdraw' })
    expect(screen.getByLabelText('How much to withdraw?')).toBeInTheDocument()
  })

  it('shows the syncing APY copy when rate is null', () => {
    setup({ rate: null })
    expect(screen.getByText('syncing…')).toBeInTheDocument()
  })

  it('shows the unavailable APY copy when the pool currently pays no yield', () => {
    setup({ rate: { rate: 1_000_000n, apyBps: 0n, fetchedAt: 0 } })
    expect(screen.getByText(/unavailable — pool currently pays no yield/)).toBeInTheDocument()
  })

  it('renders the APY percentage when apyBps is populated', () => {
    setup({ rate: { rate: 1_000_000n, apyBps: 450n, fetchedAt: 0 } })
    expect(screen.getByText('~4.50%')).toBeInTheDocument()
  })

  it('disables Continue when amount exceeds max', () => {
    setup({ max: 1_000_000n, amountStr: '5' })
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/exceeds your private balance/i)
  })

  it('shows the withdraw-specific over-max error when tab=withdraw', () => {
    setup({ tab: 'withdraw', max: 1_000_000n, amountStr: '5' })
    expect(screen.getByRole('alert')).toHaveTextContent(/exceeds your earning balance/i)
  })

  it('enables Continue when amount is positive and within max', () => {
    setup({ max: 5_000_000n, amountStr: '3' })
    expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled()
  })

  it('fires onTabChange when a tab is clicked', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Withdraw' }))
    expect(props.onTabChange).toHaveBeenCalledWith('withdraw')
  })
})
