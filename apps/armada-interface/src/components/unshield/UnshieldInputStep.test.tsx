// ABOUTME: Tests for UnshieldInputStep — Review gated on positive amount within maxInput AND a connected wallet address; xchain notice appears for client chains.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UnshieldInputStep } from './UnshieldInputStep'
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

const VALID_ADDR = '0x1234567890abcdef1234567890abcdef12345678'

const ZERO_FEES: DisplayFees = {
  protocolFee: 0n,
  gasFee: 0n,
  nativeGas: null,
  totalFee: 0n,
  feeInclusive: false,
}

function setup(extras?: {
  destChainId?: number
  walletAddress?: string | null
  amountStr?: string
  max?: bigint
  balanceSyncing?: boolean
}) {
  const max = extras?.max ?? 5_000_000n
  const destChainId = extras?.destChainId ?? 31337
  const props = {
    destChainId,
    onDestChainIdChange: vi.fn(),
    walletAddress: extras?.walletAddress === undefined ? VALID_ADDR : extras.walletAddress,
    amountStr: extras?.amountStr ?? '',
    onAmountChange: vi.fn(),
    max,
    maxInput: max,
    balanceLabel: '5.00',
    balanceSyncing: extras?.balanceSyncing ?? false,
    displayFees: ZERO_FEES,
    feeLoading: false,
    gasChainId: destChainId,
    onCancel: vi.fn(),
    onContinue: vi.fn(),
  }
  render(<UnshieldInputStep {...props} />)
  return props
}

describe('<UnshieldInputStep>', () => {
  it('disables Review when amount is empty', () => {
    setup({ amountStr: '' })
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('disables Review when no wallet is connected (walletAddress null)', () => {
    setup({ amountStr: '3', walletAddress: null })
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('disables Review when amount exceeds maxInput', () => {
    setup({ max: 1_000_000n, amountStr: '5' })
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('enables Review with a valid wallet address and in-range amount', () => {
    setup({ max: 5_000_000n, amountStr: '3' })
    expect(screen.getByRole('button', { name: /Review/ })).not.toBeDisabled()
  })

  it('disables Review while initial balance sync is still running', () => {
    setup({ max: 5_000_000n, amountStr: '3', balanceSyncing: true })
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('shows the cross-chain notice only when destination ≠ hub', () => {
    const { unmount } = render(
      <UnshieldInputStep
        destChainId={31337}
        onDestChainIdChange={vi.fn()}
        walletAddress={VALID_ADDR}
        amountStr=""
        onAmountChange={vi.fn()}
        max={1_000_000n}
        maxInput={1_000_000n}
        balanceLabel="1.00"
        balanceSyncing={false}
        displayFees={ZERO_FEES}
        feeLoading={false}
        gasChainId={31337}
        onCancel={vi.fn()}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.queryByText(/CCTP confirmation/)).toBeNull()
    unmount()
    render(
      <UnshieldInputStep
        destChainId={31338}
        onDestChainIdChange={vi.fn()}
        walletAddress={VALID_ADDR}
        amountStr=""
        onAmountChange={vi.fn()}
        max={1_000_000n}
        maxInput={1_000_000n}
        balanceLabel="1.00"
        balanceSyncing={false}
        displayFees={ZERO_FEES}
        feeLoading={false}
        gasChainId={31338}
        onCancel={vi.fn()}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.getByText(/CCTP confirmation/)).toBeInTheDocument()
  })

  it('fires onContinue when valid', () => {
    const props = setup({ max: 5_000_000n, amountStr: '3' })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel from the secondary CTA', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })
})
