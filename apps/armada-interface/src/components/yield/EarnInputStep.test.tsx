// ABOUTME: Tests for EarnInputStep — tab switching, amount validation against tab-specific maxInput, APY copy in each rate state.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EarnInputStep, type EarnTab } from './EarnInputStep'
import type { YieldRate } from '@/hooks/useYieldRate'
import type { DisplayFees } from '@/lib/fees/displayFees'

// useGasBalanceWarning hits wagmi's useAccount/useBalance which need a WagmiProvider; these
// tests don't mount one.
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

function setup(extras?: {
  tab?: EarnTab
  amountStr?: string
  max?: bigint
  rate?: YieldRate | null
}) {
  const max = extras?.max ?? 5_000_000n
  const props = {
    tab: extras?.tab ?? 'add' as EarnTab,
    onTabChange: vi.fn(),
    amountStr: extras?.amountStr ?? '',
    onAmountChange: vi.fn(),
    max,
    maxInput: max,
    displayFees: ZERO_FEES,
    feeLoading: false,
    gasChainId: 31337,
    rate: extras?.rate ?? null as YieldRate | null,
    onCancel: vi.fn(),
    onContinue: vi.fn(),
  }
  render(<EarnInputStep {...props} />)
  return props
}

describe('<EarnInputStep>', () => {
  it('renders Add to vault and Withdraw tabs', () => {
    setup()
    expect(screen.getByRole('tab', { name: 'Add to vault' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Withdraw' })).toBeInTheDocument()
  })

  it('hides the chain row (the vault has no chain selection)', () => {
    setup()
    expect(screen.queryByText(/Anvil Hub/)).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders the 25% / 50% / 75% / Max percent pills', () => {
    setup()
    for (const label of ['25%', '50%', '75%', 'Max']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('shows the APY banner on the Add tab', () => {
    setup({ tab: 'add', rate: { rate: 1_000_000n, apyBps: 450n, fetchedAt: 0 } })
    expect(screen.getByText('Earn ~4.50% APY')).toBeInTheDocument()
  })

  it('shows the APY banner on the Withdraw tab too (matches the mockup)', () => {
    setup({ tab: 'withdraw', rate: { rate: 1_000_000n, apyBps: 450n, fetchedAt: 0 } })
    expect(screen.getByText('Earn ~4.50% APY')).toBeInTheDocument()
  })

  it('uses the vault-deposit aria-label when tab=add', () => {
    setup({ tab: 'add' })
    expect(screen.getByLabelText('Vault deposit amount')).toBeInTheDocument()
  })

  it('uses the vault-withdraw aria-label when tab=withdraw', () => {
    setup({ tab: 'withdraw' })
    expect(screen.getByLabelText('Vault withdrawal amount')).toBeInTheDocument()
  })

  it('shows the syncing APY headline when rate is null', () => {
    setup({ rate: null })
    expect(screen.getByText('Estimating vault APY…')).toBeInTheDocument()
  })

  it('shows the no-yield APY headline when the pool currently pays no yield', () => {
    setup({ rate: { rate: 1_000_000n, apyBps: 0n, fetchedAt: 0 } })
    expect(screen.getByText('Vault currently pays no yield')).toBeInTheDocument()
  })

  it('renders the APY percentage headline when apyBps is populated', () => {
    setup({ rate: { rate: 1_000_000n, apyBps: 450n, fetchedAt: 0 } })
    expect(screen.getByText('Earn ~4.50% APY')).toBeInTheDocument()
  })

  it('disables Review when amount exceeds maxInput', () => {
    setup({ max: 1_000_000n, amountStr: '5' })
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/exceeds your private balance/i)
  })

  it('shows the withdraw-specific over-max error when tab=withdraw', () => {
    setup({ tab: 'withdraw', max: 1_000_000n, amountStr: '5' })
    expect(screen.getByRole('alert')).toHaveTextContent(/exceeds your earning balance/i)
  })

  it('enables Review when amount is positive and within maxInput', () => {
    setup({ max: 5_000_000n, amountStr: '3' })
    expect(screen.getByRole('button', { name: /Review/ })).not.toBeDisabled()
  })

  it('fires onTabChange when a tab is clicked', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Withdraw' }))
    expect(props.onTabChange).toHaveBeenCalledWith('withdraw')
  })

  it('disables Review and surfaces the inline reason when continueBlockedReason is set', () => {
    // WHY: the withdraw broadcaster fee comes from the user's pre-existing private USDC (not
    // from the redeem proceeds), so the modal must gate submit when private USDC < fee.
    render(
      <EarnInputStep
        tab="withdraw"
        onTabChange={vi.fn()}
        amountStr="3"
        onAmountChange={vi.fn()}
        max={5_000_000n}
        maxInput={5_000_000n}
        displayFees={ZERO_FEES}
        feeLoading={false}
        gasChainId={31337}
        rate={null}
        continueBlockedReason="You need at least 0.50 USDC in your private balance to cover the withdrawal fee."
        onCancel={vi.fn()}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Review/ })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/0\.50 USDC in your private balance/)
  })
})
