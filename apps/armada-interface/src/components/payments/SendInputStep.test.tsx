// ABOUTME: Tests for SendInputStep (amount step) — static chain display, amount gating, xchain notice, variant copy, Back/Review actions.

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
    isXchain: extras?.isXchain ?? false,
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
  it('renders the send amount question', () => {
    setup()
    expect(screen.getByText(/How much USDC do you want to send/)).toBeInTheDocument()
  })

  it('withdraw variant: uses withdraw copy + the "Withdrawal amount" field', () => {
    setup({ variant: 'withdraw' })
    expect(screen.getByText(/How much USDC do you want to withdraw/)).toBeInTheDocument()
    expect(screen.getByLabelText('Withdrawal amount')).toBeInTheDocument()
  })

  it('renders the chain statically (no interactive chain dropdown here)', () => {
    setup()
    // Chain is chosen on the recipient step; DepositAmountCard gets no onChainIdChange → static.
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /Network/i })).toBeNull()
  })

  it('gates Review on the amount — too much shows an error and disables Review', () => {
    setup({ amountStr: '10', maxInput: 5_000_000n, max: 5_000_000n })
    expect(screen.getByText(/exceeds your private balance/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('enables Review + fires onContinue for a valid amount', () => {
    const props = setup({ amountStr: '2' })
    const review = screen.getByRole('button', { name: /Review/ })
    expect(review).not.toBeDisabled()
    fireEvent.click(review)
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })

  it('no xchain notice when isXchain is false', () => {
    setup({ isXchain: false, amountStr: '1' })
    expect(screen.queryByText(/CCTP confirmation/)).toBeNull()
  })

  it('shows the xchain notice when isXchain is true', () => {
    setup({ isXchain: true, amountStr: '1' })
    expect(screen.getByText(/CCTP confirmation/)).toBeInTheDocument()
  })

  it('fires onBack from the Back button', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })
})
