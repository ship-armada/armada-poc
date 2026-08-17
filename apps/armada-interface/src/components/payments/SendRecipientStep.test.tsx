// ABOUTME: Tests for SendRecipientStep — address validity gating, private/public indicator, chain selector visibility, deployment-error gating, actions.

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
    onCancel: extras?.onCancel ?? vi.fn(),
    onContinue: extras?.onContinue ?? vi.fn(),
  }
  render(<SendRecipientStep {...props} />)
  return props
}

describe('<SendRecipientStep>', () => {
  it('send variant: asks who to send to', () => {
    setup()
    expect(screen.getByText(/Who do you want to send USDC to/)).toBeInTheDocument()
  })

  it('withdraw variant: asks where to withdraw', () => {
    setup({ variant: 'withdraw' })
    expect(screen.getByText(/Where do you want to withdraw your USDC/)).toBeInTheDocument()
  })

  it('disables Continue while the recipient is empty', () => {
    setup()
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
  })

  it('shows an error and disables Continue for a malformed address', () => {
    setup({ recipient: 'nonsense' })
    expect(screen.getByRole('alert')).toHaveTextContent(/valid shielded .* or public wallet/i)
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
  })

  it('0zk recipient: private indicator, no chain selector, Continue enabled', () => {
    setup({ recipient: VALID_0ZK })
    expect(screen.getByText(/Private transfer/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Destination chain')).toBeNull()
    expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled()
  })

  it('0x recipient: public indicator + chain selector, Continue enabled', () => {
    setup({ recipient: VALID_EVM })
    expect(screen.getByText(/Public transfer/)).toBeInTheDocument()
    expect(screen.getByLabelText('Destination chain')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Continue/ })).not.toBeDisabled()
  })

  it('fires onDestChainIdChange when the chain selection changes', () => {
    const props = setup({ recipient: VALID_EVM })
    fireEvent.change(screen.getByLabelText('Destination chain'), { target: { value: '31338' } })
    expect(props.onDestChainIdChange).toHaveBeenCalledWith(31338)
  })

  it('gates Continue + surfaces the deployment error when the chosen chain has no manifest', () => {
    setup({ recipient: VALID_EVM, destDeploymentError: 'This destination chain has no deployment manifest. Pick another chain.' })
    expect(screen.getByRole('alert')).toHaveTextContent(/no deployment manifest/i)
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled()
  })

  it('fires onContinue for a valid recipient', () => {
    const props = setup({ recipient: VALID_0ZK })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel from the Cancel button', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })
})
