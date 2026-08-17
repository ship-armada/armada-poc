// ABOUTME: Tests for SendReviewStep — mode label by isPrivate, optional chain row, cross-chain tag, variant copy, recipient truncation.

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
      variant="send"
      isPrivate
      destChainId={31337}
      recipient={VALID_0ZK}
      amount={5_000_000n}
      fee={null}
      totalDeducted={5_000_000n}
      isXchain={false}
      onBack={onBack}
      onConfirm={onConfirm}
    />,
  )
  return { onBack, onConfirm }
}

describe('<SendReviewStep>', () => {
  it('private: shows "Private transfer" mode and no chain row', () => {
    renderPrivate()
    expect(screen.getByText('Private transfer')).toBeInTheDocument()
    expect(screen.queryByText('To chain')).toBeNull()
  })

  it('private: truncates 0zk recipient with leading 0zk + ellipsis + last 4 chars', () => {
    renderPrivate()
    // 0zkabcd…aaaa
    expect(screen.getByText(/^0zkabcd…/)).toBeInTheDocument()
  })

  it('public: shows the chain row and an EVM-style truncated recipient', () => {
    render(
      <SendReviewStep
        variant="send"
        isPrivate={false}
        destChainId={31337}
        recipient={VALID_EVM}
        amount={5_000_000n}
        fee={null}
        totalDeducted={5_000_000n}
        isXchain={false}
        onBack={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText('To chain')).toBeInTheDocument()
    expect(screen.getByText(/Anvil Hub/)).toBeInTheDocument()
    expect(screen.getByText('0x1234...5678')).toBeInTheDocument()
  })

  it('public + xchain: shows the cross-chain tag', () => {
    render(
      <SendReviewStep
        variant="send"
        isPrivate={false}
        destChainId={31338}
        recipient={VALID_EVM}
        amount={5_000_000n}
        fee={null}
        totalDeducted={5_000_000n}
        isXchain
        onBack={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText('cross-chain')).toBeInTheDocument()
  })

  it('withdraw variant: uses the withdrawal headline + confirm label', () => {
    render(
      <SendReviewStep
        variant="withdraw"
        isPrivate={false}
        destChainId={31337}
        recipient={VALID_EVM}
        amount={5_000_000n}
        fee={null}
        totalDeducted={5_000_000n}
        isXchain={false}
        onBack={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText('Review your withdrawal')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm withdrawal/ })).toBeInTheDocument()
  })

  it('send variant: fires onConfirm on the primary CTA', () => {
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
