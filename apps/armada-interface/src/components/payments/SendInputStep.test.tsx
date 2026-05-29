// ABOUTME: Tests for SendInputStep — tab switching, per-tab recipient validation, Continue gating, xchain notice gating.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendInputStep, type SendTab } from './SendInputStep'

const VALID_EVM = '0x1234567890abcdef1234567890abcdef12345678'
const VALID_0ZK = '0zk' + 'a'.repeat(40)

function setup(extras?: {
  tab?: SendTab
  destChainId?: number
  recipient?: string
  amountStr?: string
  max?: bigint
}) {
  const props = {
    tab: extras?.tab ?? 'private' as SendTab,
    onTabChange: vi.fn(),
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
    isXchain: (extras?.tab ?? 'private') === 'external' && (extras?.destChainId ?? 31337) !== 31337,
    isLocalUnshield: (extras?.tab ?? 'private') === 'external' && (extras?.destChainId ?? 31337) === 31337,
    onCancel: vi.fn(),
    onContinue: vi.fn(),
  }
  render(<SendInputStep {...props} />)
  return props
}

describe('<SendInputStep>', () => {
  it('renders the Private and External tabs', () => {
    setup()
    expect(screen.getByRole('tab', { name: /Private/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /External wallet/ })).toBeInTheDocument()
  })

  it('private tab: hides the chain selector', () => {
    setup({ tab: 'private' })
    expect(screen.queryByLabelText('To chain')).toBeNull()
  })

  it('external tab: shows the chain selector', () => {
    setup({ tab: 'external' })
    expect(screen.getByLabelText('To chain')).toBeInTheDocument()
  })

  it('private tab: rejects an EVM address with an inline error', () => {
    setup({ tab: 'private', recipient: VALID_EVM, amountStr: '1' })
    expect(screen.getByRole('alert')).toHaveTextContent(/valid shielded address/i)
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
  })

  it('private tab: accepts a 0zk address', () => {
    setup({ tab: 'private', recipient: VALID_0ZK, amountStr: '1' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled()
  })

  it('external tab: rejects a 0zk address', () => {
    setup({ tab: 'external', recipient: VALID_0ZK, amountStr: '1' })
    expect(screen.getByRole('alert')).toHaveTextContent(/valid EVM address/i)
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
  })

  it('external tab + hub destination: no xchain notice', () => {
    setup({ tab: 'external', destChainId: 31337, recipient: VALID_EVM, amountStr: '1' })
    expect(screen.queryByText(/CCTP confirmation/)).toBeNull()
  })

  it('external tab + client destination: shows xchain notice', () => {
    setup({ tab: 'external', destChainId: 31338, recipient: VALID_EVM, amountStr: '1' })
    expect(screen.getByText(/CCTP confirmation/)).toBeInTheDocument()
  })

  it('fires onTabChange when a tab is clicked', () => {
    const props = setup({ tab: 'private' })
    fireEvent.click(screen.getByRole('tab', { name: /External wallet/ }))
    expect(props.onTabChange).toHaveBeenCalledWith('external')
  })

  it('fires onContinue when valid', () => {
    const props = setup({ tab: 'private', recipient: VALID_0ZK, amountStr: '2' })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })
})
