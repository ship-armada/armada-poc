// ABOUTME: Tests for SignInFlow — single state-agnostic sign-in + restore-behind-a-link (backup file / paste secret) + the signer-incompatible → full-page screen route.
// ABOUTME: useShieldedWallet + wagmi + RainbowKit are mocked at the import boundary so no live engine/provider tree is needed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { NonDeterministicSignerError } from '@/lib/crypto/determinism'

const mockSignIn = vi.fn()
const mockUnlockByPaste = vi.fn()
const mockUnlockByBackup = vi.fn()
const mockOpenConnectModal = vi.fn()
const mockDisconnect = vi.fn()

const wagmiState = {
  isConnected: false as boolean,
  address: undefined as string | undefined,
}

vi.mock('@/hooks/useShieldedWallet', () => ({
  useShieldedWallet: () => ({
    signIn: mockSignIn,
    unlockByPaste: mockUnlockByPaste,
    unlockByBackup: mockUnlockByBackup,
    // remaining surface isn't exercised but must exist so the destructure compiles
    state: null,
    enroll: vi.fn(),
    lock: vi.fn(),
    reset: vi.fn(),
    exportBackup: vi.fn(),
  }),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: wagmiState.isConnected, address: wagmiState.address }),
  useDisconnect: () => ({ disconnect: mockDisconnect }),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => ({ openConnectModal: mockOpenConnectModal }),
}))

import { SignInFlow } from './SignInFlow'

function renderWith(opts?: { isConnected?: boolean; address?: string }) {
  wagmiState.isConnected = opts?.isConnected ?? false
  wagmiState.address = opts?.address
  const store = createStore()
  const onUnlocked = vi.fn()
  render(
    <Provider store={store}>
      <SignInFlow onUnlocked={onUnlocked} />
    </Provider>,
  )
  return { onUnlocked }
}

/** Reveal the restore view (backup form is the default restore mode). */
function openRestore() {
  fireEvent.click(screen.getByRole('button', { name: 'Restore wallet from backup instead' }))
}

beforeEach(() => {
  mockSignIn.mockReset()
  mockUnlockByPaste.mockReset()
  mockUnlockByBackup.mockReset()
  mockOpenConnectModal.mockReset()
  mockDisconnect.mockReset()
})

describe('<SignInFlow> — sign-in (default, state-agnostic)', () => {
  it('renders the single sign-in screen — no tabs, no create-account copy', () => {
    renderWith()
    expect(screen.getByRole('region', { name: 'Sign in to your account' })).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByText(/create.*account/i)).not.toBeInTheDocument()
  })

  it('hides the first-time banner when disconnected (first-time is unknown)', () => {
    renderWith({ isConnected: false })
    expect(screen.queryByText(/two signatures to confirm your wallet is compatible/i)).toBeNull()
  })

  it('shows the first-time two-signature banner when connected with no cached wallet', () => {
    // Empty localStorage (no cached walletId) → first sign on this device → banner shows.
    renderWith({ isConnected: true, address: '0xabcdef0123456789abcdef0123456789abcdef01' })
    expect(
      screen.getByText(/two signatures to confirm your wallet is compatible/i),
    ).toBeInTheDocument()
  })

  it('shows Connect wallet when disconnected and opens the RainbowKit modal', () => {
    renderWith({ isConnected: false })
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(mockOpenConnectModal).toHaveBeenCalledTimes(1)
  })

  it('shows the truncated connected address and calls signIn() → onUnlocked', async () => {
    mockSignIn.mockResolvedValueOnce(undefined)
    const { onUnlocked } = renderWith({
      isConnected: true,
      address: '0xabcdef0123456789abcdef0123456789abcdef01',
    })
    expect(screen.getByText(/0xabcd.+ef01/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
  })

  it('surfaces a non-determinism-unrelated sign-in error inline (stays on sign-in)', async () => {
    mockSignIn.mockRejectedValueOnce(new Error('Connect an EVM wallet before signing in.'))
    renderWith({ isConnected: true, address: '0xabcd1234' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Connect an EVM wallet/))
    expect(screen.getByRole('region', { name: 'Sign in to your account' })).toBeInTheDocument()
  })
})

describe('<SignInFlow> — signer incompatible', () => {
  it('routes a NonDeterministicSignerError to the full-page compatibility screen', async () => {
    mockSignIn.mockRejectedValueOnce(new NonDeterministicSignerError('first-sign-mismatch'))
    const { onUnlocked } = renderWith({ isConnected: true, address: '0xabcd1234' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use a backup file or recovery secret' })).toBeInTheDocument(),
    )
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it('"Use a backup file or recovery secret" lands on the restore view with a banner', async () => {
    mockSignIn.mockRejectedValueOnce(new NonDeterministicSignerError('cached-checksum-mismatch'))
    renderWith({ isConnected: true, address: '0xabcd1234' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use a backup file or recovery secret' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use a backup file or recovery secret' }))
    expect(screen.getByRole('region', { name: 'Restore your account' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/encrypted backup file/i)
    expect(screen.getByLabelText('Backup file')).toBeInTheDocument()
  })

  it('"Try a different wallet" disconnects and returns to sign-in', async () => {
    mockSignIn.mockRejectedValueOnce(new NonDeterministicSignerError('first-sign-mismatch'))
    renderWith({ isConnected: true, address: '0xabcd1234' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try a different wallet' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try a different wallet' }))
    expect(mockDisconnect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('region', { name: 'Sign in to your account' })).toBeInTheDocument()
  })
})

describe('<SignInFlow> — restore behind the link', () => {
  it('opens the restore view (backup form) from the quiet link', () => {
    renderWith()
    openRestore()
    expect(screen.getByRole('region', { name: 'Restore your account' })).toBeInTheDocument()
    expect(screen.getByLabelText('Backup file')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument()
  })

  it('disables Restore until a file + ≥8-char passphrase are provided, then calls unlockByBackup', async () => {
    const { onUnlocked } = renderWith()
    openRestore()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
    mockUnlockByBackup.mockResolvedValueOnce(undefined)
    const file = new File(['{}'], 'wallet.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [file] } })
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'pw-here-now' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(mockUnlockByBackup).toHaveBeenCalledTimes(1))
    expect(mockUnlockByBackup.mock.calls[0]?.[0]).toBe(file)
    expect(mockUnlockByBackup.mock.calls[0]?.[1]).toBe('pw-here-now')
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
  })

  it('toggles to paste-secret and calls unlockByPaste', async () => {
    const { onUnlocked } = renderWith()
    openRestore()
    fireEvent.click(screen.getByRole('button', { name: 'Paste a recovery secret instead' }))
    mockUnlockByPaste.mockResolvedValueOnce(undefined)
    const hex = 'a'.repeat(64)
    fireEvent.change(screen.getByLabelText(/Recovery secret/), { target: { value: hex } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(mockUnlockByPaste).toHaveBeenCalledWith(hex))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
  })

  it('"Back to sign in" returns to the sign-in view', () => {
    renderWith()
    openRestore()
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(screen.getByRole('region', { name: 'Sign in to your account' })).toBeInTheDocument()
  })
})
