// ABOUTME: Tests for UnshieldCompleteStep — renders success copy with formatted amount + truncated recipient + chain name; Done dispatches onDone.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UnshieldCompleteStep } from './UnshieldCompleteStep'

const VALID_ADDR = '0xabcdef1234567890abcdef1234567890abcdef12'

describe('<UnshieldCompleteStep>', () => {
  it('renders the headline and the success body copy', () => {
    render(
      <UnshieldCompleteStep
        destChainId={31337}
        recipient={VALID_ADDR}
        recipientReceives={250_500_000n}
        onDone={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Withdrawal complete' })).toBeInTheDocument()
    expect(screen.getByText(/250\.50 USDC/)).toBeInTheDocument()
    expect(screen.getByText(/0xabcd\.{3}ef12/)).toBeInTheDocument()
    expect(screen.getByText(/Anvil Hub/)).toBeInTheDocument()
  })

  it('fires onDone when the Done CTA is clicked', () => {
    const onDone = vi.fn()
    render(
      <UnshieldCompleteStep
        destChainId={31337}
        recipient={VALID_ADDR}
        recipientReceives={1_000_000n}
        onDone={onDone}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Done/ }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
