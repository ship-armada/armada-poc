// ABOUTME: Tests for the shared Shield/Unshield amount step — footer Review gating + direction-driven title/tabs.
// ABOUTME: Footer gating mirrors the retired ShieldInputStep coverage (empty / 0 / exceeds max / at-or-below fee floor).

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { modalStepBodyEnter, modalActionRowEnter } from '@/design'
import {
  ShieldAmountStepContent,
  ShieldAmountStepFooter,
  type ShieldTab,
} from './ShieldAmountStep'
import type { DisplayFees } from '@/lib/fees/displayFees'
import type { FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'

vi.mock('@/hooks/useGasBalanceWarning', () => ({
  useGasBalanceWarning: () => ({ show: false, nativeSymbol: 'ETH', formattedBalance: null }),
}))

const DISPLAY_FEES: DisplayFees = {
  protocolFee: 0n,
  gasFee: 0n,
  nativeGas: null,
  totalFee: 0n,
  feeInclusive: false,
}
const FLOW_BREAKDOWN: FlowFeeBreakdown = {
  broadcasterFee: 0n,
  recipientReceives: 0n,
  totalDeducted: 0n,
  recipientLabel: "You'll deposit",
}

function renderContent(tab: ShieldTab, onTabChange = vi.fn()) {
  return render(
    <ShieldAmountStepContent
      tab={tab}
      onTabChange={onTabChange}
      chainId={31337}
      onChainIdChange={vi.fn()}
      amountStr=""
      onAmountChange={vi.fn()}
      balance="100.00"
      maxInput={100_000_000n}
      minAmount={0n}
      displayFees={DISPLAY_FEES}
      flowBreakdown={FLOW_BREAKDOWN}
      gasChainId={31337}
    />,
  )
}

function renderFooter(amountStr: string, minAmount = 0n, onContinue = vi.fn(), onCancel = vi.fn()) {
  const { container } = render(
    <ShieldAmountStepFooter
      amountStr={amountStr}
      maxInput={100_000_000n}
      minAmount={minAmount}
      onContinue={onContinue}
      onCancel={onCancel}
    />,
  )
  return { onContinue, onCancel, container }
}

describe('ShieldAmountStepContent (direction)', () => {
  it('shows shield copy + both tabs on the shield tab', () => {
    renderContent('shield')
    expect(screen.getByText('Shield your USDC')).toBeInTheDocument()
    expect(screen.getByLabelText('Shield amount')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Shield' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Unshield' })).toBeInTheDocument()
  })

  it('shows unshield copy on the unshield tab', () => {
    renderContent('unshield')
    expect(screen.getByText('Unshield your USDC')).toBeInTheDocument()
    expect(screen.getByLabelText('Unshield amount')).toBeInTheDocument()
  })

  it('fires onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn()
    renderContent('shield', onTabChange)
    fireEvent.click(screen.getByRole('tab', { name: 'Unshield' }))
    expect(onTabChange).toHaveBeenCalledWith('unshield')
  })
})

describe('ShieldAmountStep step-enter animation (regression)', () => {
  // The amount step is the only step that once shipped without the FlowShell step-enter classes,
  // so its main card never transitioned in on open. Guard both the body + footer enter hooks here.
  it('applies modalStepBodyEnter to the content wrapper', () => {
    const { container } = renderContent('shield')
    expect((container.firstChild as HTMLElement).className).toContain(modalStepBodyEnter)
  })

  it('applies modalActionRowEnter to the footer button row', () => {
    const { container } = renderFooter('5')
    expect((container.firstChild as HTMLElement).className).toContain(modalActionRowEnter)
  })
})

describe('ShieldAmountStepFooter (Review gating)', () => {
  it('disables Review when the amount is empty', () => {
    renderFooter('')
    expect(screen.getByRole('button', { name: /Review|Input amount/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it("labels the CTA 'Input amount' when there is no valid amount", () => {
    // Mockup parity: the disabled primary CTA is instructional ("Input amount"), not a dead "Review".
    // The enabled-state "Review" label is covered by 'enables Review for a positive amount'.
    renderFooter('')
    expect(screen.getByRole('button', { name: 'Input amount' })).toBeInTheDocument()
  })

  it('disables Review when the amount is 0', () => {
    renderFooter('0')
    expect(screen.getByRole('button', { name: /Review|Input amount/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('disables Review when the amount exceeds maxInput', () => {
    renderFooter('200') // maxInput = 100 USDC
    expect(screen.getByRole('button', { name: /Review|Input amount/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('enables Review for a positive amount within maxInput', () => {
    renderFooter('5')
    expect(screen.getByRole('button', { name: /Review/ })).not.toBeDisabled()
  })

  it('rejects an amount at or below the relayer-fee floor (shield)', () => {
    renderFooter('1', 1_000_000n) // minAmount = 1 USDC; amount = 1 → not > fee
    expect(screen.getByRole('button', { name: /Review|Input amount/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('fires onContinue / onCancel from the CTAs', () => {
    const { onContinue, onCancel } = renderFooter('5')
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(onContinue).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('taps to nudge: the disabled "Input amount" CTA fires onIncompleteContinue, not onContinue', () => {
    const onContinue = vi.fn()
    const onIncompleteContinue = vi.fn()
    render(
      <ShieldAmountStepFooter
        amountStr=""
        maxInput={100_000_000n}
        minAmount={0n}
        onContinue={onContinue}
        onCancel={vi.fn()}
        onIncompleteContinue={onIncompleteContinue}
      />,
    )
    const cta = screen.getByRole('button', { name: 'Input amount' })
    // With an onDisabledClick handler wired, the incomplete CTA stays DOM-clickable but aria-disabled.
    expect(cta).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(cta)
    expect(onContinue).not.toHaveBeenCalled()
    expect(onIncompleteContinue).toHaveBeenCalledTimes(1)
  })
})
