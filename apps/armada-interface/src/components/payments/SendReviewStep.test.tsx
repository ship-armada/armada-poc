// ABOUTME: Tests for SendReviewStep — mode label per tab, optional chain row, cross-chain tag, recipient truncation (0zk vs 0x).

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendReviewStep } from './SendReviewStep'

const VALID_EVM = '0x1234567890abcdef1234567890abcdef12345678'
const VALID_0ZK = '0zkabcdefghijklmnopqrstuvwxyz0123456789aaaa'

function renderPrivate() {
  const onBack = vi.fn()
  const onConfirm = vi.fn()
  render(
    <SendReviewStep
      tab="private"
      destChainId={31337}
      recipient={VALID_0ZK}
      amount={5_000_000n}
      fee={null}
      cctpFee={0n}
      recipientReceives={5_000_000n}
      totalDeducted={5_000_000n}
      isLocalUnshield={false}
      isXchain={false}
      onBack={onBack}
      onConfirm={onConfirm}
    />,
  )
  return { onBack, onConfirm }
}

describe('<SendReviewStep>', () => {
  it('private tab: shows "Private transfer" mode and no chain row', () => {
    renderPrivate()
    expect(screen.getByText('Private transfer')).toBeInTheDocument()
    expect(screen.queryByText('To chain')).toBeNull()
  })

  it('private tab: truncates 0zk recipient with leading 0zk + ellipsis + last 4 chars', () => {
    renderPrivate()
    // 0zkabcd…aaaa
    expect(screen.getByText(/^0zkabcd…/)).toBeInTheDocument()
  })

  it('external tab: shows the chain row and an EVM-style truncated recipient', () => {
    render(
      <SendReviewStep
        tab="external"
        destChainId={31337}
        recipient={VALID_EVM}
        amount={5_000_000n}
        fee={null}
        cctpFee={0n}
        recipientReceives={5_000_000n}
      totalDeducted={5_000_000n}
      isLocalUnshield={false}
        isXchain={false}
        onBack={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText('To chain')).toBeInTheDocument()
    expect(screen.getByText(/Anvil Hub/)).toBeInTheDocument()
    expect(screen.getByText('0x1234...5678')).toBeInTheDocument()
  })

  it('external + xchain: shows the cross-chain tag', () => {
    render(
      <SendReviewStep
        tab="external"
        destChainId={31338}
        recipient={VALID_EVM}
        amount={5_000_000n}
        fee={null}
        cctpFee={20_000n}
        recipientReceives={5_000_000n}
      totalDeducted={5_000_000n}
      isLocalUnshield={false}
        isXchain
        onBack={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText('cross-chain')).toBeInTheDocument()
  })

  it('fires onConfirm on the primary CTA', () => {
    const { onConfirm } = renderPrivate()
    fireEvent.click(screen.getByRole('button', { name: /Confirm send/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onBack on the secondary CTA', () => {
    const { onBack } = renderPrivate()
    fireEvent.click(screen.getByRole('button', { name: /^Back/ }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
