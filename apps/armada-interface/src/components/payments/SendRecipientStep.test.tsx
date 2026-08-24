// ABOUTME: Tests for SendRecipientStep — address validity, private/public badge, chain-selector visibility, deployment-error gating, Cancel/Continue.
// ABOUTME: The action row is always visible — Continue stays disabled + labeled "Enter address" until the address is valid.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SendRecipientStep, type SendRecipientStepProps } from './SendRecipientStep'

const VALID_EVM = '0x1234567890abcdef1234567890abcdef12345678'
const VALID_0ZK = '0zk' + 'a'.repeat(40)

function setup(extras?: Partial<SendRecipientStepProps>) {
  const props: SendRecipientStepProps = {
    variant: extras?.variant ?? 'send',
    recipient: extras?.recipient ?? '',
    onRecipientChange: extras?.onRecipientChange ?? vi.fn(),
    destChainId: extras?.destChainId ?? 31337,
    onDestChainIdChange: extras?.onDestChainIdChange ?? vi.fn(),
    destDeploymentError: extras?.destDeploymentError,
    recentAddresses: extras?.recentAddresses ?? [],
    onSelectRecent: extras?.onSelectRecent ?? vi.fn(),
    onCancel: extras?.onCancel ?? vi.fn(),
    onContinue: extras?.onContinue ?? vi.fn(),
  }
  render(<SendRecipientStep {...props} />)
  return props
}

describe('<SendRecipientStep>', () => {
  it('send variant prompts "Send your USDC to:"', () => {
    setup({ variant: 'send' })
    expect(screen.getByRole('heading', { name: /Send your USDC to:/ })).toBeInTheDocument()
  })

  it('withdraw variant prompts "Where do you want to unshield your USDC?"', () => {
    setup({ variant: 'withdraw' })
    expect(screen.getByRole('heading', { name: /Where do you want to unshield your USDC\?/ })).toBeInTheDocument()
  })

  it('shows a disabled "Enter address" CTA while the recipient is empty', () => {
    setup()
    expect(screen.getByRole('button', { name: /Enter address/ })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('button', { name: /^Continue$/ })).toBeNull()
  })

  it('shows an error and keeps the CTA disabled + labeled "Enter address" for a malformed address', () => {
    setup({ recipient: 'nonsense' })
    expect(screen.getByRole('alert')).toHaveTextContent(/valid 0zk or 0x/i)
    expect(screen.getByRole('button', { name: /Enter address/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('nudge: tapping the disabled CTA focuses the recipient input (incomplete-CTA nudge)', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Enter address/ }))
    expect(screen.getByLabelText('Recipient address')).toHaveFocus()
  })

  it('0zk recipient: private badge, no chain selector, Continue enabled', () => {
    setup({ recipient: VALID_0ZK })
    expect(screen.getByText('Private address')).toBeInTheDocument()
    expect(screen.queryByLabelText('Destination chain')).toBeNull()
    expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled()
  })

  it('0x recipient: public badge + chain selector, Continue enabled', () => {
    setup({ recipient: VALID_EVM })
    expect(screen.getByText('Public address')).toBeInTheDocument()
    expect(screen.getByLabelText('Destination chain')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled()
  })

  it('fires onDestChainIdChange when the chain selection changes', () => {
    const props = setup({ recipient: VALID_EVM })
    fireEvent.click(screen.getByLabelText('Destination chain'))
    fireEvent.click(screen.getByRole('option', { name: /Anvil Client A/ }))
    expect(props.onDestChainIdChange).toHaveBeenCalledWith(31338)
  })

  it('gates Continue + surfaces the deployment error when the chosen chain has no manifest', () => {
    setup({
      recipient: VALID_EVM,
      destDeploymentError: 'This destination chain has no deployment manifest. Pick another chain.',
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/no deployment manifest/i)
    // The address is valid so the label reads "Continue", but the deployment error keeps it disabled.
    expect(screen.getByRole('button', { name: /^Continue$/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('fires onContinue for a valid recipient', () => {
    const props = setup({ recipient: VALID_0ZK })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when the Cancel button is clicked', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders the recent-recipients list and fires onSelectRecent on a row click', () => {
    const recent = [
      { address: VALID_EVM, kind: 'unshield-local' as const, destChainId: 31337, lastAt: 0 },
    ]
    const props = setup({ recentAddresses: recent })
    expect(screen.getByText('Recent address')).toBeInTheDocument()
    fireEvent.click(screen.getByText(/0x1234\.\.\.5678/))
    expect(props.onSelectRecent).toHaveBeenCalledWith(recent[0])
  })

  it('omits the recent section when there is no history', () => {
    setup({ recentAddresses: [] })
    expect(screen.queryByText('Recent address')).toBeNull()
  })
})
