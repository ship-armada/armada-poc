// ABOUTME: Tests for SendInputStep (amount step) — no chain row, percent pills, amount gating, variant copy, Back/Review actions.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendInputStep, type SendInputStepProps } from './SendInputStep'
import type { DisplayFees } from '@/lib/fees/displayFees'

// useGasBalanceWarning hits wagmi's useAccount/useBalance which need a WagmiProvider; these
// tests don't mount one. "No warning" keeps GasBalanceNotice hidden.
vi.mock('@/hooks/useGasBalanceWarning', () => ({
  useGasBalanceWarning: () => ({
    show: false,
    nativeSymbol: 'ETH',
    formattedBalance: null,
  }),
}))

const ZERO_FEES: DisplayFees = {
  protocolFee: 0n,
  gasFee: 0n,
  nativeGas: null,
  totalFee: 0n,
  feeInclusive: false,
}

function setup(extras?: Partial<SendInputStepProps>) {
  const max = extras?.max ?? 5_000_000n
  const props: SendInputStepProps = {
    variant: extras?.variant ?? 'send',
    destChainId: extras?.destChainId ?? 31337,
    amountStr: extras?.amountStr ?? '',
    onAmountChange: extras?.onAmountChange ?? vi.fn(),
    max,
    maxInput: extras?.maxInput ?? max,
    displayFees: extras?.displayFees ?? ZERO_FEES,
    feeLoading: false,
    gasChainId: extras?.gasChainId ?? 31337,
    onBack: extras?.onBack ?? vi.fn(),
    onContinue: extras?.onContinue ?? vi.fn(),
  }
  render(<SendInputStep {...props} />)
  return props
}

describe('<SendInputStep>', () => {
  it('renders the amount question', () => {
    setup()
    expect(screen.getByText('How much USDC?')).toBeInTheDocument()
  })

  it('withdraw variant: keeps the static title + exposes the "Withdrawal amount" field', () => {
    setup({ variant: 'withdraw' })
    expect(screen.getByText('How much USDC?')).toBeInTheDocument()
    expect(screen.getByLabelText('Withdrawal amount')).toBeInTheDocument()
  })

  it('hides the chain row entirely (chosen on the recipient step; not in the mockup)', () => {
    setup({ destChainId: 31337 })
    // No chain name, no dropdown — the send amount card has no chain row.
    expect(screen.queryByText(/Anvil Hub/)).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders the 25% / 50% / 75% / Max percent pills', () => {
    setup()
    for (const label of ['25%', '50%', '75%', 'Max']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('a percent pill sets the amount to that fraction of the input cap', () => {
    const props = setup({ maxInput: 5_000_000n, max: 5_000_000n })
    fireEvent.click(screen.getByRole('button', { name: '50%' }))
    expect(props.onAmountChange).toHaveBeenCalledWith('2.5')
  })

  it('gates Review on the amount — too much shows an error and disables Review', () => {
    setup({ amountStr: '10', maxInput: 5_000_000n, max: 5_000_000n })
    expect(screen.getByText(/more than you can send/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Review|Input amount/ })).toBeDisabled()
  })

  it('enables Review + fires onContinue for a valid amount', () => {
    const props = setup({ amountStr: '2' })
    const review = screen.getByRole('button', { name: /Review/ })
    expect(review).not.toBeDisabled()
    fireEvent.click(review)
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })

  it('fires onBack from the Back button', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })
})
