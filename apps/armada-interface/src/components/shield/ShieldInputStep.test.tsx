// ABOUTME: Tests for ShieldInputStep — Review gated on a positive amount within maxInput, error surfaces when amount exceeds max or undercuts minAmount.
// ABOUTME: Provides max + maxInput via props; DepositAmountCard renders the balance text and forwards onMax/onAmountChange.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ShieldInputStep } from './ShieldInputStep'
import type { DisplayFees } from '@/lib/fees/displayFees'

// useGasBalanceWarning reads from wagmi's useAccount/useBalance which require WagmiProvider;
// these tests don't mount one. Default to "no warning" so the GasBalanceNotice stays hidden.
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
  feeInclusive: true,
}

function setup(extras?: { max?: bigint; amountStr?: string; minAmount?: bigint }) {
  const max = extras?.max ?? 5_000_000n
  const props = {
    fromChainId: 31337,
    onFromChainIdChange: vi.fn(),
    amountStr: extras?.amountStr ?? '',
    onAmountChange: vi.fn(),
    max,
    // Without a per-tx broadcaster fee the input cap = the raw balance. Tests that exercise
    // the broadcaster-fee path can override.
    maxInput: max,
    minAmount: extras?.minAmount ?? 0n,
    displayFees: ZERO_FEES,
    feeLoading: false,
    onCancel: vi.fn(),
    onContinue: vi.fn(),
  }
  render(<ShieldInputStep {...props} />)
  return props
}

describe('<ShieldInputStep>', () => {
  it('disables Review when the amount is empty', () => {
    setup()
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('disables Review when the amount is 0', () => {
    setup({ amountStr: '0' })
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('disables Review and surfaces an error when amount exceeds maxInput', () => {
    setup({ max: 1_000_000n, amountStr: '5' })
    expect(screen.getByRole('alert')).toHaveTextContent(/exceeds your available balance/i)
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('enables Review when amount is positive and within maxInput', () => {
    setup({ max: 5_000_000n, amountStr: '4' })
    expect(screen.getByRole('button', { name: /Review/ })).not.toBeDisabled()
  })

  it('disables Review and surfaces an error when amount is at or below the relayer fee', () => {
    // WHY: pin the B3/B4 gasless-shield invariant. With fee-from-recipient semantics the
    // shielded value is `amount - fee`; entering amount ≤ fee would either shield zero or
    // underflow on-chain.
    setup({ max: 5_000_000n, amountStr: '2', minAmount: 2_000_000n })
    expect(screen.getByRole('alert')).toHaveTextContent(/greater than the relayer fee/i)
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('still rejects amount strictly equal to the minAmount (fee parity)', () => {
    setup({ max: 5_000_000n, amountStr: '2.5', minAmount: 2_500_000n })
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('accepts amount > minAmount (one-unit-above-fee)', () => {
    setup({ max: 5_000_000n, amountStr: '2.5', minAmount: 2_499_999n })
    expect(screen.getByRole('button', { name: /Review/ })).not.toBeDisabled()
  })

  it('fires onContinue when the user submits a valid amount', () => {
    const props = setup({ max: 5_000_000n, amountStr: '4' })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel from the secondary CTA', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })
})
