// ABOUTME: Tests for SeedManager component — address parsing and validation logic.
// ABOUTME: Verifies valid/invalid count display, duplicate handling, and max-seeds check.

import { render, screen, fireEvent } from '@testing-library/react'
import { SeedManager } from './SeedManager'

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

const VALID_ADDR_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const VALID_ADDR_2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const INVALID_ADDR = '0xinvalid'

describe('SeedManager', () => {
  it('renders the textarea and seed count', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={10} />)
    expect(screen.getByPlaceholderText(/paste addresses/i)).toBeInTheDocument()
    expect(screen.getByText('10 / 150')).toBeInTheDocument()
  })

  it('shows valid count for valid addresses', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={0} />)
    const textarea = screen.getByPlaceholderText(/paste addresses/i)
    fireEvent.change(textarea, { target: { value: `${VALID_ADDR_1}\n${VALID_ADDR_2}` } })
    expect(screen.getByText('2 valid')).toBeInTheDocument()
  })

  it('shows invalid count for bad addresses', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={0} />)
    const textarea = screen.getByPlaceholderText(/paste addresses/i)
    fireEvent.change(textarea, { target: { value: `${VALID_ADDR_1}\n${INVALID_ADDR}` } })
    expect(screen.getByText('1 valid')).toBeInTheDocument()
    expect(screen.getByText('1 invalid')).toBeInTheDocument()
  })

  it('deduplicates addresses (case-insensitive)', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={0} />)
    const textarea = screen.getByPlaceholderText(/paste addresses/i)
    fireEvent.change(textarea, {
      target: { value: `${VALID_ADDR_1}\n${VALID_ADDR_1.toLowerCase()}` },
    })
    expect(screen.getByText('1 valid')).toBeInTheDocument()
  })

  it('warns when exceeding remaining slots', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={149} />)
    const textarea = screen.getByPlaceholderText(/paste addresses/i)
    fireEvent.change(textarea, { target: { value: `${VALID_ADDR_1}\n${VALID_ADDR_2}` } })
    expect(screen.getByText(/exceeds remaining/i)).toBeInTheDocument()
  })

  it('button is disabled when no valid addresses', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={0} />)
    const button = screen.getByRole('button', { name: /add 0 seed/i })
    expect(button).toBeDisabled()
  })

  it('parses comma-separated addresses', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={0} />)
    const textarea = screen.getByPlaceholderText(/paste addresses/i)
    fireEvent.change(textarea, { target: { value: `${VALID_ADDR_1}, ${VALID_ADDR_2}` } })
    expect(screen.getByText('2 valid')).toBeInTheDocument()
  })

  it('parses semicolon-separated addresses', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={0} />)
    const textarea = screen.getByPlaceholderText(/paste addresses/i)
    fireEvent.change(textarea, { target: { value: `${VALID_ADDR_1}; ${VALID_ADDR_2}` } })
    expect(screen.getByText('2 valid')).toBeInTheDocument()
  })
})
