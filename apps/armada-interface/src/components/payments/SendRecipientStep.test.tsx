// ABOUTME: Tests for SendRecipientStep — address validity, private/public reveal badge, chain-selector visibility, deployment-error gating, Continue.
// ABOUTME: The footer (privacy badge + Continue) reveals only once the address is valid — matches the mockup (no persistent buttons).

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
    onContinue: extras?.onContinue ?? vi.fn(),
  }
  render(<SendRecipientStep {...props} />)
  return props
}

describe('<SendRecipientStep>', () => {
  it('prompts "Where do you want to send your USDC?" (both variants)', () => {
    setup()
    expect(screen.getByRole('heading', { name: /Where do you want to/ })).toBeInTheDocument()
  })

  it('shows no Continue button while the recipient is empty', () => {
    setup()
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
  })

  it('shows an error and no Continue for a malformed address', () => {
    setup({ recipient: 'nonsense' })
    expect(screen.getByRole('alert')).toHaveTextContent(/valid shielded .* or public wallet/i)
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
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
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
  })

  it('fires onContinue for a valid recipient', () => {
    const props = setup({ recipient: VALID_0ZK })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })
})
