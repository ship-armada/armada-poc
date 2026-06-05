// ABOUTME: Tests for RecipientInput — controlled value, error rendering, Paste button visibility/disabling.
// ABOUTME: Clipboard integration is left to integration tests; jsdom doesn't implement navigator.clipboard reliably.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RecipientInput } from './RecipientInput'

describe('<RecipientInput>', () => {
  it('renders the label', () => {
    render(<RecipientInput value="" onValueChange={() => {}} label="Recipient" />)
    expect(screen.getByLabelText('Recipient')).toBeInTheDocument()
  })

  it('renders the current value', () => {
    render(<RecipientInput value="0xabc" onValueChange={() => {}} label="Recipient" />)
    expect(screen.getByDisplayValue('0xabc')).toBeInTheDocument()
  })

  it('fires onValueChange when the user types', () => {
    const onValueChange = vi.fn()
    render(<RecipientInput value="" onValueChange={onValueChange} label="Recipient" />)
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: '0xabc' } })
    expect(onValueChange).toHaveBeenCalledWith('0xabc')
  })

  it('renders an error message when error prop is set', () => {
    render(<RecipientInput value="" onValueChange={() => {}} error="Bad address" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Bad address')
  })

  it('renders the Paste button by default and hides it when showPasteButton=false', () => {
    const { rerender } = render(<RecipientInput value="" onValueChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Paste from clipboard' })).toBeInTheDocument()
    rerender(<RecipientInput value="" onValueChange={() => {}} showPasteButton={false} />)
    expect(screen.queryByRole('button', { name: 'Paste from clipboard' })).toBeNull()
  })

  it('disables the input and Paste button when disabled', () => {
    render(<RecipientInput value="" onValueChange={() => {}} label="Recipient" disabled />)
    expect(screen.getByLabelText('Recipient')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Paste from clipboard' })).toBeDisabled()
  })

  it('renders a wallet icon when showWalletIcon is set', () => {
    const { container } = render(
      <RecipientInput
        value="0xabc"
        onValueChange={() => {}}
        label="Recipient"
        showWalletIcon
        showPasteButton={false}
        disabled
      />,
    )
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Paste from clipboard' })).toBeNull()
  })
})
