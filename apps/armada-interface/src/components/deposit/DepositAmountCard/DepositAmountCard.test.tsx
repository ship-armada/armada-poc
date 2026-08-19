// ABOUTME: Tests for DepositAmountCard's balance row — specifically the pendingBalance suffix that
// ABOUTME: surfaces not-yet-spendable ("pending") notes alongside the available balance.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { formatUsdcPlain } from '@/lib/format'
import { DepositAmountCard } from './DepositAmountCard'

const CHAINS = [{ chainId: 31337, label: 'Hub' }]

/** Temporarily report non-reduced motion (setup defaults to reduced) for the duration of `fn`. */
function withMotionEnabled(fn: () => void) {
  const original = window.matchMedia
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia
  try {
    fn()
  } finally {
    window.matchMedia = original
  }
}

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

describe('DepositAmountCard — presets + amount roll', () => {
  it('commits a fraction of maxInput when a percentage pill is clicked', () => {
    const onAmountChange = vi.fn()
    // 12 USDC cap → 25% is 3 USDC (integer bigint math, no float rounding).
    renderCard({ maxInput: 12_000000n, onAmountChange })
    fireEvent.click(screen.getByRole('button', { name: '25%' }))
    expect(onAmountChange).toHaveBeenCalledWith(formatUsdcPlain(3_000000n))
  })

  it('delegates Max to the caller-supplied onMax (fee-on-top cap) over the maxInput fraction', () => {
    const onMax = vi.fn()
    const onAmountChange = vi.fn()
    renderCard({ maxInput: 12_000000n, onMax, onAmountChange })
    fireEvent.click(screen.getByRole('button', { name: 'Max' }))
    expect(onMax).toHaveBeenCalledTimes(1)
    // onMax owns the amount update; the card does not also commit its own fraction.
    expect(onAmountChange).not.toHaveBeenCalled()
  })

  it('freezes the input into a roll while a preset lands (motion enabled)', () => {
    withMotionEnabled(() => {
      const onAmountChange = vi.fn()
      const { rerender } = render(
        <DepositAmountCard
          chains={CHAINS}
          chainId={31337}
          amount="1"
          onAmountChange={onAmountChange}
          maxInput={12_000000n}
          amountAriaLabel="Deposit amount"
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: '50%' }))
      // The parent commits the new amount → the roll effect starts on the prop change.
      rerender(
        <DepositAmountCard
          chains={CHAINS}
          chainId={31337}
          amount="6"
          onAmountChange={onAmountChange}
          maxInput={12_000000n}
          amountAriaLabel="Deposit amount"
        />,
      )
      // While the odometer plays, the underlying input is held read-only.
      expect(screen.getByLabelText('Deposit amount')).toHaveAttribute('readonly')
    })
  })

  it('does not roll under reduced motion — the amount updates without freezing the input', () => {
    const onAmountChange = vi.fn()
    const { rerender } = render(
      <DepositAmountCard
        chains={CHAINS}
        chainId={31337}
        amount="1"
        onAmountChange={onAmountChange}
        maxInput={12_000000n}
        amountAriaLabel="Deposit amount"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '50%' }))
    rerender(
      <DepositAmountCard
        chains={CHAINS}
        chainId={31337}
        amount="6"
        onAmountChange={onAmountChange}
        maxInput={12_000000n}
        amountAriaLabel="Deposit amount"
      />,
    )
    expect(screen.getByLabelText('Deposit amount')).not.toHaveAttribute('readonly')
  })
})
