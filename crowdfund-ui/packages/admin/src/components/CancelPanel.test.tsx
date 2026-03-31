// ABOUTME: Tests for CancelPanel component — confirmation gate logic.
// ABOUTME: Verifies the button is disabled until "CANCEL" is typed exactly.

import { render, screen, fireEvent } from '@testing-library/react'
import { CancelPanel } from './CancelPanel'

// Mock useTransactionFlow to avoid ethers dependency
vi.mock('@/hooks/useTransactionFlow', () => ({
  useTransactionFlow: () => ({
    state: { status: 'idle', txHash: null, receipt: null, error: null },
    execute: vi.fn(),
    reset: vi.fn(),
  }),
}))

// Mock TransactionFlow to render nothing
vi.mock('./TransactionFlow', () => ({
  TransactionFlow: () => null,
}))

describe('CancelPanel', () => {
  it('renders the confirmation input', () => {
    render(<CancelPanel signer={null} crowdfundAddress="0x1234" />)
    expect(screen.getByPlaceholderText('Type CANCEL to confirm')).toBeInTheDocument()
  })

  it('button is disabled when confirmation is empty', () => {
    render(<CancelPanel signer={null} crowdfundAddress="0x1234" />)
    const button = screen.getByRole('button', { name: /cancel crowdfund/i })
    expect(button).toBeDisabled()
  })

  it('button is disabled with partial text', () => {
    render(<CancelPanel signer={null} crowdfundAddress="0x1234" />)
    const input = screen.getByPlaceholderText('Type CANCEL to confirm')
    fireEvent.change(input, { target: { value: 'CANC' } })
    const button = screen.getByRole('button', { name: /cancel crowdfund/i })
    expect(button).toBeDisabled()
  })

  it('button is enabled when "CANCEL" is typed exactly', () => {
    render(<CancelPanel signer={null} crowdfundAddress="0x1234" />)
    const input = screen.getByPlaceholderText('Type CANCEL to confirm')
    fireEvent.change(input, { target: { value: 'CANCEL' } })
    const button = screen.getByRole('button', { name: /cancel crowdfund/i })
    expect(button).not.toBeDisabled()
  })

  it('button is disabled for lowercase "cancel"', () => {
    render(<CancelPanel signer={null} crowdfundAddress="0x1234" />)
    const input = screen.getByPlaceholderText('Type CANCEL to confirm')
    fireEvent.change(input, { target: { value: 'cancel' } })
    const button = screen.getByRole('button', { name: /cancel crowdfund/i })
    expect(button).toBeDisabled()
  })

  it('shows irreversible warning text', () => {
    render(<CancelPanel signer={null} crowdfundAddress="0x1234" />)
    expect(screen.getByText(/irreversible/i)).toBeInTheDocument()
  })
})
