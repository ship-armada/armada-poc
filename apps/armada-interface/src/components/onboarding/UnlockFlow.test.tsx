// ABOUTME: Tests for UnlockFlow — three tabs (Sign in [V2 primary] / Backup file / Paste secret) wired to useShieldedWallet.
// ABOUTME: useShieldedWallet + wagmi + RainbowKit are all mocked at the import boundary so we don't need a live engine or wallet provider tree.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { NonDeterministicSignerError } from '@/lib/crypto/determinism'

const mockSignIn = vi.fn()
const mockUnlockByPaste = vi.fn()
const mockUnlockByBackup = vi.fn()
const mockOpenConnectModal = vi.fn()

// `useAccount` is reassigned per-test via this object so a single module-level mock can pretend
// to be either connected or disconnected. The wagmi mock dispatches to this getter.
const wagmiState = {
  isConnected: false as boolean,
  address: undefined as string | undefined,
}

vi.mock('@/hooks/useShieldedWallet', () => ({
  useShieldedWallet: () => ({
    signIn: mockSignIn,
    unlockByPaste: mockUnlockByPaste,
    unlockByBackup: mockUnlockByBackup,
    // remaining surface is not exercised by UnlockFlow but must exist so the destructure compiles
    state: null,
    enroll: vi.fn(),
    lock: vi.fn(),
    reset: vi.fn(),
    exportBackup: vi.fn(),
  }),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: wagmiState.isConnected, address: wagmiState.address }),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => ({ openConnectModal: mockOpenConnectModal }),
}))

import { UnlockFlow } from './UnlockFlow'

function renderWith(opts?: {
  onCreateNew?: () => void
  isConnected?: boolean
  address?: string
}) {
  wagmiState.isConnected = opts?.isConnected ?? false
  wagmiState.address = opts?.address
  const store = createStore()
  const onUnlocked = vi.fn()
  render(
    <Provider store={store}>
      <UnlockFlow onUnlocked={onUnlocked} onCreateNew={opts?.onCreateNew} />
    </Provider>,
  )
  return { onUnlocked }
}

beforeEach(() => {
  mockSignIn.mockReset()
  mockUnlockByPaste.mockReset()
  mockUnlockByBackup.mockReset()
  mockOpenConnectModal.mockReset()
})

describe('<UnlockFlow> — sign-in tab (V2 primary, default)', () => {
  it('renders the dialog with the Sign in tab selected by default', () => {
    renderWith()
    expect(screen.getByRole('region', { name: 'Unlock your account' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Backup file' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Paste secret' })).toBeInTheDocument()
  })

  it('shows a Connect wallet button when no EVM wallet is connected', () => {
    renderWith({ isConnected: false })
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument()
  })

  it('opens the RainbowKit modal when the Connect wallet button is clicked', () => {
    renderWith({ isConnected: false })
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(mockOpenConnectModal).toHaveBeenCalledTimes(1)
  })

  it('shows the truncated connected EVM address when a wallet is connected', () => {
    renderWith({ isConnected: true, address: '0xabcdef0123456789abcdef0123456789abcdef01' })
    // Truncate format: 0xabcd…ef01
    expect(screen.getByText(/0xabcd.+ef01/)).toBeInTheDocument()
  })

  it('calls signIn() and fires onUnlocked on a successful sign-in', async () => {
    mockSignIn.mockResolvedValueOnce({ rootSecret: new Uint8Array(32), state: { id: 'x', status: 'unlocked' } })
    const { onUnlocked } = renderWith({ isConnected: true, address: '0xabcd1234' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
  })

  it('routes a NonDeterministicSignerError to the Backup file tab with a banner', async () => {
    mockSignIn.mockRejectedValueOnce(new NonDeterministicSignerError('cached-checksum-mismatch'))
    const { onUnlocked } = renderWith({ isConnected: true, address: '0xabcd1234' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Backup file' })).toHaveAttribute('aria-selected', 'true')
    })
    // Banner with the user-facing nudge text.
    expect(screen.getByRole('status')).toHaveTextContent(/encrypted backup file/i)
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it('surfaces non-determinism-unrelated sign-in errors inline (no tab switch)', async () => {
    mockSignIn.mockRejectedValueOnce(new Error('Connect an EVM wallet before signing in.'))
    renderWith({ isConnected: true, address: '0xabcd1234' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Connect an EVM wallet/))
    expect(screen.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('<UnlockFlow> — backup mode', () => {
  it('lets the user switch to the Backup file tab and renders its form', () => {
    renderWith()
    fireEvent.click(screen.getByRole('tab', { name: 'Backup file' }))
    expect(screen.getByLabelText('Backup file')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument()
  })

  it('disables Unlock until both a file and a passphrase are provided', () => {
    renderWith()
    fireEvent.click(screen.getByRole('tab', { name: 'Backup file' }))
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled()
  })

  it('calls unlockByBackup with (file, passphrase) on submit', async () => {
    const { onUnlocked } = renderWith()
    mockUnlockByBackup.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole('tab', { name: 'Backup file' }))
    const file = new File(['{}'], 'wallet.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [file] } })
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(mockUnlockByBackup).toHaveBeenCalledTimes(1))
    expect(mockUnlockByBackup.mock.calls[0]?.[0]).toBe(file)
    expect(mockUnlockByBackup.mock.calls[0]?.[1]).toBe('pw')
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
  })
})

describe('<UnlockFlow> — paste mode', () => {
  it('disables Unlock until a value is pasted', () => {
    renderWith()
    fireEvent.click(screen.getByRole('tab', { name: 'Paste secret' }))
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled()
  })

  it('calls unlockByPaste with the hex value and fires onUnlocked on success', async () => {
    const { onUnlocked } = renderWith()
    mockUnlockByPaste.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole('tab', { name: 'Paste secret' }))
    const hex = 'a'.repeat(64)
    fireEvent.change(screen.getByLabelText(/Recovery secret/), { target: { value: hex } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(mockUnlockByPaste).toHaveBeenCalledWith(hex))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
  })

  it('surfaces the lib error inline and does not advance', async () => {
    const { onUnlocked } = renderWith()
    mockUnlockByPaste.mockRejectedValueOnce(new Error('Recovery secret must be 64 hex chars.'))
    fireEvent.click(screen.getByRole('tab', { name: 'Paste secret' }))
    fireEvent.change(screen.getByLabelText(/Recovery secret/), { target: { value: 'x'.repeat(64) } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Recovery secret must be 64 hex chars.'))
    expect(onUnlocked).not.toHaveBeenCalled()
  })
})

describe('<UnlockFlow> — mode switching', () => {
  it('clears in-progress paste value when switching tabs', () => {
    renderWith()
    fireEvent.click(screen.getByRole('tab', { name: 'Paste secret' }))
    fireEvent.change(screen.getByLabelText(/Recovery secret/), { target: { value: 'abcdef' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Backup file' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Paste secret' }))
    expect(screen.getByLabelText(/Recovery secret/)).toHaveValue('')
  })
})

describe('<UnlockFlow> — Create-new escape hatch', () => {
  it('does NOT render the Create-new link when onCreateNew is not supplied', () => {
    renderWith()
    expect(screen.queryByRole('button', { name: /Create a new account/ })).not.toBeInTheDocument()
  })

  it('renders the Create-new link when onCreateNew is supplied and fires it on click', () => {
    const onCreateNew = vi.fn()
    renderWith({ onCreateNew })
    const btn = screen.getByRole('button', { name: /Create a new account/ })
    fireEvent.click(btn)
    expect(onCreateNew).toHaveBeenCalledTimes(1)
  })

  it('renders the Create-new link in all tab modes', () => {
    const onCreateNew = vi.fn()
    renderWith({ onCreateNew })
    expect(screen.getByRole('button', { name: /Create a new account/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Backup file' }))
    expect(screen.getByRole('button', { name: /Create a new account/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Paste secret' }))
    expect(screen.getByRole('button', { name: /Create a new account/ })).toBeInTheDocument()
  })
})
