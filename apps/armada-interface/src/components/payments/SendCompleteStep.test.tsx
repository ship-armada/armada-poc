// ABOUTME: Tests for SendCompleteStep — copy adapts to private vs public + variant, Done dispatches onDone.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendCompleteStep } from './SendCompleteStep'

const VALID_EVM = '0xabcdef1234567890abcdef1234567890abcdef12'
const VALID_0ZK = '0zkabcdefghijklmnopqrstuvwxyz0123456789aaaa'

describe('<SendCompleteStep>', () => {
  it("private: renders the 'sent privately' copy", () => {
    render(
      <SendCompleteStep
        variant="send"
        isPrivate
        destChainId={31337}
        recipient={VALID_0ZK}
        recipientReceives={100_000_000n}
        totalDeducted={100_000_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.getByText(/privately/)).toBeInTheDocument()
    expect(screen.getByText(/100\.00 USDC/)).toBeInTheDocument()
  })

  it('public: renders the chain name in the copy', () => {
    render(
      <SendCompleteStep
        variant="send"
        isPrivate={false}
        destChainId={31337}
        recipient={VALID_EVM}
        recipientReceives={50_000_000n}
        totalDeducted={50_000_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.getByText(/Anvil Hub/)).toBeInTheDocument()
    expect(screen.getByText(/50\.00 USDC/)).toBeInTheDocument()
  })

  it('withdraw variant: uses the "Withdrawal complete" title', () => {
    render(
      <SendCompleteStep
        variant="withdraw"
        isPrivate={false}
        destChainId={31337}
        recipient={VALID_EVM}
        recipientReceives={50_000_000n}
        totalDeducted={50_000_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.getByText('Withdrawal complete')).toBeInTheDocument()
  })

  it('fires onDone when the CTA is clicked', () => {
    const onDone = vi.fn()
    render(
      <SendCompleteStep
        variant="send"
        isPrivate
        destChainId={31337}
        recipient={VALID_0ZK}
        recipientReceives={1_000_000n}
        totalDeducted={1_000_000n}
        onDone={onDone}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Done/ }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
