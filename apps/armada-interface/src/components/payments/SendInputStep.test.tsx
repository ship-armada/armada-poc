// ABOUTME: Tests for SendInputStep — tab switching, per-tab recipient validation, Review gating, xchain notice gating.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendInputStep, type SendTab } from './SendInputStep'
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

const VALID_EVM = '0x1234567890abcdef1234567890abcdef12345678'
const VALID_0ZK = '0zk' + 'a'.repeat(40)

const ZERO_FEES: DisplayFees = {
  protocolFee: 0n,
  gasFee: 0n,
  nativeGas: null,
  totalFee: 0n,
  feeInclusive: false,
}

function setup(extras?: {
  tab?: SendTab
  destChainId?: number
  recipient?: string
  amountStr?: string
  max?: bigint
}) {
  const max = extras?.max ?? 5_000_000n
  const props = {
    tab: extras?.tab ?? 'private' as SendTab,
    onTabChange: vi.fn(),
    destChainId: extras?.destChainId ?? 31337,
    onDestChainIdChange: vi.fn(),
    recipient: extras?.recipient ?? '',
    onRecipientChange: vi.fn(),
    amountStr: extras?.amountStr ?? '',
    onAmountChange: vi.fn(),
    max,
    maxInput: max,
    displayFees: ZERO_FEES,
    feeLoading: false,
    gasChainId: extras?.destChainId ?? 31337,
    onCancel: vi.fn(),
    onContinue: vi.fn(),
  }
  render(<SendInputStep {...props} />)
  return props
}

describe('<SendInputStep>', () => {
  it('renders the Private and External tabs', () => {
    setup()
    expect(screen.getByRole('tab', { name: /Private/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /External wallet/ })).toBeInTheDocument()
  })

  it('private tab: hides the chain selector', () => {
    setup({ tab: 'private' })
    // Private mode locks to hub — DepositAmountCard renders chain name as static text only
    // (no listbox role; chainSelectable is false when chains.length === 1).
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('external tab: shows the chain selector', () => {
    setup({ tab: 'external' })
    // External mode passes all chains — chain dropdown is interactive (aria-haspopup="listbox").
    expect(screen.getByRole('button', { name: /Network|Anvil|Sepolia|Base|Arbitrum/i })).toBeInTheDocument()
  })

  it('private tab: rejects an EVM address with an inline error', () => {
    setup({ tab: 'private', recipient: VALID_EVM, amountStr: '1' })
    expect(screen.getByRole('alert')).toHaveTextContent(/valid shielded address/i)
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('private tab: accepts a 0zk address', () => {
    setup({ tab: 'private', recipient: VALID_0ZK, amountStr: '1' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /Review/ })).not.toBeDisabled()
  })

  it('external tab: rejects a 0zk address', () => {
    setup({ tab: 'external', recipient: VALID_0ZK, amountStr: '1' })
    expect(screen.getByRole('alert')).toHaveTextContent(/valid EVM address/i)
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
  })

  it('external tab + hub destination: no xchain notice', () => {
    setup({ tab: 'external', destChainId: 31337, recipient: VALID_EVM, amountStr: '1' })
    expect(screen.queryByText(/CCTP confirmation/)).toBeNull()
  })

  it('external tab + client destination: shows xchain notice', () => {
    setup({ tab: 'external', destChainId: 31338, recipient: VALID_EVM, amountStr: '1' })
    expect(screen.getByText(/CCTP confirmation/)).toBeInTheDocument()
  })

  it('fires onTabChange when a tab is clicked', () => {
    const props = setup({ tab: 'private' })
    fireEvent.click(screen.getByRole('tab', { name: /External wallet/ }))
    expect(props.onTabChange).toHaveBeenCalledWith('external')
  })

  it('fires onContinue when valid', () => {
    const props = setup({ tab: 'private', recipient: VALID_0ZK, amountStr: '2' })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })
})
