// ABOUTME: Tests for UnshieldInputStep — Continue gated on positive amount within max AND valid EVM recipient; xchain notice appears for client chains.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UnshieldInputStep } from './UnshieldInputStep'

const VALID_ADDR = '0x1234567890abcdef1234567890abcdef12345678'

function setup(extras?: {
  destChainId?: number
  recipient?: string
  amountStr?: string
  max?: bigint
}) {
  const props = {
    destChainId: extras?.destChainId ?? 31337,
    onDestChainIdChange: vi.fn(),
    recipient: extras?.recipient ?? '',
    onRecipientChange: vi.fn(),
    amountStr: extras?.amountStr ?? '',
    onAmountChange: vi.fn(),
    max: extras?.max ?? 5_000_000n,
    fee: null as bigint | null,
    cctpFee: 0n,
    recipientReceives: 0n,
    totalDeducted: 0n,
    isXchain: (extras?.destChainId ?? 31337) !== 31337,
    onCancel: vi.fn(),
    onContinue: vi.fn(),
  }
  render(<UnshieldInputStep {...props} />)
  return props
}

describe('<UnshieldInputStep>', () => {
  it('disables Continue when recipient is empty', () => {
    setup({ amountStr: '5' })
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
  })

  it('disables Continue when recipient is malformed and surfaces an error', () => {
    setup({ amountStr: '5', recipient: 'not-an-address' })
    expect(screen.getByRole('alert')).toHaveTextContent(/valid EVM address/i)
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
  })

  it('disables Continue when amount exceeds max', () => {
    setup({ max: 1_000_000n, amountStr: '5', recipient: VALID_ADDR })
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
  })

  it('enables Continue with a valid recipient and in-range amount', () => {
    setup({ max: 5_000_000n, amountStr: '3', recipient: VALID_ADDR })
    expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled()
  })

  it('shows the cross-chain notice only when destination ≠ hub', () => {
    const { rerender } = render(
      <UnshieldInputStep
        destChainId={31337}
        onDestChainIdChange={vi.fn()}
        recipient={VALID_ADDR}
        onRecipientChange={vi.fn()}
        amountStr=""
        onAmountChange={vi.fn()}
        max={1_000_000n}
        fee={null}
        cctpFee={0n}
        recipientReceives={0n}
        totalDeducted={0n}
        isXchain={false}
        onCancel={vi.fn()}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.queryByText(/CCTP confirmation/)).toBeNull()
    rerender(
      <UnshieldInputStep
        destChainId={31338}
        onDestChainIdChange={vi.fn()}
        recipient={VALID_ADDR}
        onRecipientChange={vi.fn()}
        amountStr=""
        onAmountChange={vi.fn()}
        max={1_000_000n}
        fee={null}
        cctpFee={0n}
        recipientReceives={0n}
        totalDeducted={0n}
        isXchain
        onCancel={vi.fn()}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.getByText(/CCTP confirmation/)).toBeInTheDocument()
  })

  it('fires onContinue when valid', () => {
    const props = setup({ max: 5_000_000n, amountStr: '3', recipient: VALID_ADDR })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel from the secondary CTA', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })
})
