// ABOUTME: Tests the "Address not whitelisted" participate screen: a close (X) control like the other flow
// ABOUTME: screens, alongside the "Connect a different wallet" action.
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Step1WalletNotWhitelisted from './Step1WalletNotWhitelisted'

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'

describe('Step1WalletNotWhitelisted', () => {
  afterEach(cleanup)

  // WHY: every other participate modal has an X; without one this screen could only be left with
  // Escape or by switching wallets, which a user who just wanted to look around would not expect.
  it('closes the flow from the X button', () => {
    const onClose = vi.fn()
    render(<Step1WalletNotWhitelisted address={ADDRESS} onSelectAnother={() => {}} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close participate flow' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // WHY: switching wallets stays available as the primary action.
  it('keeps the connect-a-different-wallet action', () => {
    const onSelectAnother = vi.fn()
    render(<Step1WalletNotWhitelisted address={ADDRESS} onSelectAnother={onSelectAnother} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect a different wallet' }))
    expect(onSelectAnother).toHaveBeenCalledTimes(1)
  })
})
