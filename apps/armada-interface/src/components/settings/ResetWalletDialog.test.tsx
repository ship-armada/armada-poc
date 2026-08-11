// ABOUTME: Tests for ResetWalletDialog — typed-confirmation gate, Cancel close, surface stub error.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { ResetWalletDialog } from './ResetWalletDialog'
import { activeShieldedWalletIdAtom, shieldedWalletsAtom } from '@/state/wallet'

function renderDialog() {
  const store = createStore()
  // Seed an active wallet so reset() actually calls into the lib stub.
  store.set(shieldedWalletsAtom, {
    'rg-1': { id: 'rg-1', status: 'unlocked', shieldedAddress: '0zk-test' },
  })
  store.set(activeShieldedWalletIdAtom, 'rg-1')
  const onClose = vi.fn()
  render(
    <Provider store={store}>
      <ResetWalletDialog open onClose={onClose} />
    </Provider>,
  )
  return { onClose, store }
}

describe('<ResetWalletDialog>', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("disables Reset until the user types the magic word", () => {
    renderDialog()
    const btn = screen.getByRole('button', { name: /^Reset wallet/ })
    expect(btn).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'not-it' } })
    expect(btn).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'reset' } })
    expect(btn).not.toBeDisabled()
  })

  it('Cancel calls onClose', () => {
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces the stub failure as an inline error', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'reset' } })
    fireEvent.click(screen.getByRole('button', { name: /^Reset wallet/ }))
    await waitFor(() => {
      // resetWallet now throws "no wallet to reset" when called with no unlocked session and
      // no cached walletId (the case in this test fixture). The dialog surfaces the error in
      // the alert region. Commit 6 (Settings dialog rewrite) will update this for the new flow.
      expect(screen.getByRole('alert').textContent ?? '').not.toBe('')
    })
  })
})
