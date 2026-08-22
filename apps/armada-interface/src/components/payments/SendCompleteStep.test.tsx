// ABOUTME: Tests for SendCompleteStep — confirmed title by variant, date/network summary rows (privacy notice hidden once confirmed), CTA wiring.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendCompleteStep, type SendCompleteStepProps } from './SendCompleteStep'

const VALID_EVM = '0xabcdef1234567890abcdef1234567890abcdef12'
const VALID_0ZK = '0zkabcdefghijklmnopqrstuvwxyz0123456789aaaa'

function renderComplete(extras?: Partial<SendCompleteStepProps>) {
  const props: SendCompleteStepProps = {
    variant: extras?.variant ?? 'send',
    recipient: extras?.recipient ?? VALID_0ZK,
    armadaAddress: extras?.armadaAddress,
    amount: extras?.amount ?? 100_000_000n,
    fee: extras?.fee ?? null,
    totalDeducted: extras?.totalDeducted ?? 100_000_000n,
    networkName: extras?.networkName,
    confirmedAt: extras?.confirmedAt ?? Date.now(),
    explorerUrl: extras?.explorerUrl,
    onViewExplorer: extras?.onViewExplorer ?? vi.fn(),
    onGoToDashboard: extras?.onGoToDashboard ?? vi.fn(),
  }
  render(<SendCompleteStep {...props} />)
  return props
}

describe('<SendCompleteStep>', () => {
  it('send: renders the "USDC shielded transfer confirmed" title + date row + amount (privacy notice hidden)', () => {
    renderComplete({ recipient: VALID_0ZK })
    expect(screen.getByText('USDC shielded transfer confirmed')).toBeInTheDocument()
    expect(screen.getByText('Date and time')).toBeInTheDocument()
    // The privacy notice is only shown pre-confirmation; the confirmed view omits it.
    expect(screen.queryByText('Private transfer.')).toBeNull()
    expect(screen.getAllByText(/100\.00 USDC/).length).toBeGreaterThan(0)
  })

  it('public: renders the network row + amount (no privacy notice once confirmed)', () => {
    renderComplete({
      recipient: VALID_EVM,
      networkName: 'Anvil Hub (local)',
      amount: 50_000_000n,
      totalDeducted: 50_000_000n,
    })
    expect(screen.getByText('Anvil Hub (local)')).toBeInTheDocument()
    expect(screen.queryByText('Public transfer.')).toBeNull()
    expect(screen.getAllByText(/50\.00 USDC/).length).toBeGreaterThan(0)
  })

  it('withdraw variant: uses the "USDC unshield confirmed" title', () => {
    renderComplete({ variant: 'withdraw', recipient: VALID_EVM, networkName: 'Anvil Hub (local)' })
    expect(screen.getByText('USDC unshield confirmed')).toBeInTheDocument()
  })

  it('disables "View on explorer" when no explorer URL is provided', () => {
    renderComplete()
    expect(screen.getByRole('button', { name: /View on explorer/ })).toBeDisabled()
  })

  it('fires onGoToDashboard when the primary CTA is clicked', () => {
    const onGoToDashboard = vi.fn()
    renderComplete({ onGoToDashboard })
    fireEvent.click(screen.getByRole('button', { name: /Go to dashboard/ }))
    expect(onGoToDashboard).toHaveBeenCalledTimes(1)
  })

  it('fires onViewExplorer when a URL is present', () => {
    const onViewExplorer = vi.fn()
    renderComplete({ explorerUrl: 'https://example.test/tx/0xabc', onViewExplorer })
    fireEvent.click(screen.getByRole('button', { name: /View on explorer/ }))
    expect(onViewExplorer).toHaveBeenCalledTimes(1)
  })
})
