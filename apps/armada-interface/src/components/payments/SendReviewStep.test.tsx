// ABOUTME: Tests for SendReviewStep — privacy notice by recipient format, optional network row, variant copy, recipient truncation, CTAs.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendReviewStep, type SendReviewStepProps } from './SendReviewStep'

const VALID_EVM = '0x1234567890abcdef1234567890abcdef12345678'
const VALID_0ZK = '0zkabcdefghijklmnopqrstuvwxyz0123456789aaaa'

function renderReview(extras?: Partial<SendReviewStepProps>) {
  const props: SendReviewStepProps = {
    variant: extras?.variant ?? 'send',
    recipient: extras?.recipient ?? VALID_0ZK,
    armadaAddress: extras?.armadaAddress,
    amount: extras?.amount ?? 5_000_000n,
    fee: extras?.fee ?? null,
    totalDeducted: extras?.totalDeducted ?? 5_000_000n,
    networkName: extras?.networkName,
    submitBlockedReason: extras?.submitBlockedReason,
    isSubmitting: extras?.isSubmitting,
    onBack: extras?.onBack ?? vi.fn(),
    onConfirm: extras?.onConfirm ?? vi.fn(),
  }
  render(<SendReviewStep {...props} />)
  return props
}

describe('<SendReviewStep>', () => {
  it('private: shows the "Private transfer." notice and no network row', () => {
    renderReview({ recipient: VALID_0ZK })
    expect(screen.getByText('Private transfer.')).toBeInTheDocument()
    expect(screen.queryByText('Network')).toBeNull()
  })

  it('private: truncates the 0zk recipient (6 chars + ellipsis + last 4)', () => {
    renderReview({ recipient: VALID_0ZK })
    // truncateAddress → "0zkabc...aaaa"
    expect(screen.getByText('0zkabc...aaaa')).toBeInTheDocument()
  })

  it('public: shows the network row + a "Public transfer." notice + an EVM-style truncated recipient', () => {
    renderReview({
      recipient: VALID_EVM,
      networkName: 'Anvil Hub (local)',
    })
    expect(screen.getByText('Network')).toBeInTheDocument()
    expect(screen.getByText('Anvil Hub (local)')).toBeInTheDocument()
    expect(screen.getByText('Public transfer.')).toBeInTheDocument()
    expect(screen.getByText('0x1234...5678')).toBeInTheDocument()
  })

  it('withdraw variant: uses the unshield title + "Confirm" label', () => {
    renderReview({ variant: 'withdraw', recipient: VALID_EVM, networkName: 'Anvil Hub (local)' })
    expect(screen.getByText('Review unshielding transfer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
  })

  it('send variant: uses the transfer title + fires onConfirm on the primary CTA', () => {
    const { onConfirm } = renderReview()
    expect(screen.getByText('Review your USDC shielded transfer')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Confirm send/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onBack on the secondary CTA', () => {
    const { onBack } = renderReview()
    fireEvent.click(screen.getByRole('button', { name: /^Back/ }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('disables Confirm while a submit is in flight', () => {
    renderReview({ isSubmitting: true })
    expect(screen.getByRole('button', { name: /Confirm send/ })).toBeDisabled()
  })
})
