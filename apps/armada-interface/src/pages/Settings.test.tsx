// ABOUTME: Tests for the Settings page — three sections render, gated buttons honor wallet state, preference selects/toggles wire to atom.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { Settings } from './Settings'
import { activeShieldedWalletIdAtom, shieldedWalletsAtom } from '@/state/wallet'
import { preferencesAtom, DEFAULT_PREFERENCES } from '@/state/preferences'

function renderSettings(opts?: { walletUnlocked?: boolean; noWallet?: boolean }) {
  const store = createStore()
  if (!opts?.noWallet) {
    store.set(shieldedWalletsAtom, {
      'rg-1': {
        id: 'rg-1',
        status: opts?.walletUnlocked ? 'unlocked' : 'locked',
        shieldedAddress: '0zk-test',
      },
    })
    store.set(activeShieldedWalletIdAtom, 'rg-1')
  }
  render(
    <Provider store={store}>
      <Settings />
    </Provider>,
  )
  return store
}

describe('<Settings>', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('renders the three section titles', () => {
    renderSettings({ walletUnlocked: true })
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Private wallet' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Preferences' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Advanced' })).toBeInTheDocument()
  })

  it("enables Lock and Export when the wallet is unlocked", () => {
    renderSettings({ walletUnlocked: true })
    expect(screen.getByRole('button', { name: 'Lock' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Export' })).not.toBeDisabled()
  })

  it('disables Lock and Export when the wallet is locked', () => {
    renderSettings({ walletUnlocked: false })
    expect(screen.getByRole('button', { name: 'Lock' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
  })

  it('disables Reset when no wallet exists', () => {
    renderSettings({ noWallet: true })
    expect(screen.getByRole('button', { name: 'Reset…' })).toBeDisabled()
  })

  it('persists the auto-lock change to the preferences atom', () => {
    const store = renderSettings({ walletUnlocked: true })
    expect(store.get(preferencesAtom)).toEqual(DEFAULT_PREFERENCES)
    fireEvent.change(screen.getByLabelText('Auto-lock timer'), { target: { value: '5' } })
    expect(store.get(preferencesAtom).autoLockMinutes).toBe(5)
  })

  it('persists the technical-details toggle to the preferences atom', () => {
    const store = renderSettings({ walletUnlocked: true })
    expect(store.get(preferencesAtom).showTechnicalDetailsByDefault).toBe(false)
    fireEvent.click(screen.getByLabelText('Show technical details by default'))
    expect(store.get(preferencesAtom).showTechnicalDetailsByDefault).toBe(true)
  })

  it('shows the network mode in Advanced', () => {
    renderSettings({ walletUnlocked: true })
    // jsdom env defaults VITE_NETWORK to "local" via vitest.config.
    expect(screen.getByText('local')).toBeInTheDocument()
  })
})
