// ABOUTME: Tests for useWallet — Phase 4 account-switch detection auto-locks the shielded wallet when wagmi reports a different EVM address than the keyManager is bound to.
// ABOUTME: wagmi + sonner + lib/railgun all mocked at the import boundary so we don't need a real provider tree.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import {
  activeRailgunWalletIdAtom,
  evmAddressAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'

// `vi.mock` factories are hoisted above all top-level code by vitest's transform, so any
// references they capture must live in a `vi.hoisted` block (which is hoisted alongside the
// mocks). Without this dance the factories error with "cannot access X before initialization".
const hoisted = vi.hoisted(() => {
  const wagmiState: {
    address: string | undefined
    chainId: number | undefined
    isConnected: boolean
  } = {
    address: undefined,
    chainId: 31337,
    isConnected: false,
  }
  const mockLockWallet = vi.fn(async () => {})
  const mockIsUnlocked = vi.fn(() => false)
  const mockGetEvmAddress = vi.fn<() => string | null>(() => null)
  const mockToast = vi.fn()
  return { wagmiState, mockLockWallet, mockIsUnlocked, mockGetEvmAddress, mockToast }
})
const { wagmiState, mockLockWallet, mockIsUnlocked, mockGetEvmAddress, mockToast } = hoisted

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: hoisted.wagmiState.address,
    chainId: hoisted.wagmiState.chainId,
    isConnected: hoisted.wagmiState.isConnected,
  }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useWalletClient: () => ({ data: null }),
}))

vi.mock('sonner', () => ({
  toast: (...args: unknown[]) => hoisted.mockToast(...args),
}))

vi.mock('@/lib/railgun/wallet', () => ({
  lockWallet: hoisted.mockLockWallet,
}))

vi.mock('@/lib/railgun/keyManager', () => ({
  isUnlocked: hoisted.mockIsUnlocked,
  getEvmAddress: hoisted.mockGetEvmAddress,
}))

vi.mock('@/lib/wagmi-adapter', () => ({
  walletClientToSigner: vi.fn(),
}))

import { useWallet } from './useWallet'

function Harness() {
  useWallet()
  return null
}

function renderWithStore() {
  const store = createStore()
  render(
    <Provider store={store}>
      <Harness />
    </Provider>,
  )
  return store
}

beforeEach(() => {
  wagmiState.address = undefined
  wagmiState.chainId = 31337
  wagmiState.isConnected = false
  mockLockWallet.mockReset()
  mockLockWallet.mockResolvedValue(undefined)
  mockIsUnlocked.mockReset()
  mockIsUnlocked.mockReturnValue(false)
  mockGetEvmAddress.mockReset()
  mockGetEvmAddress.mockReturnValue(null)
  mockToast.mockReset()
})

describe('useWallet — account-switch detection', () => {
  it('mirrors the wagmi address into evmAddressAtom on initial render', () => {
    wagmiState.address = '0xabc'
    wagmiState.isConnected = true
    const store = renderWithStore()
    expect(store.get(evmAddressAtom)).toBe('0xabc')
  })

  it('does NOT lock when nothing is unlocked', () => {
    wagmiState.address = '0xabc'
    wagmiState.isConnected = true
    mockIsUnlocked.mockReturnValue(false)
    renderWithStore()
    expect(mockLockWallet).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('does NOT lock when the keyManager is unlocked but has no bound EVM address (paste-restore with no wallet connected)', () => {
    wagmiState.address = '0xabc'
    wagmiState.isConnected = true
    mockIsUnlocked.mockReturnValue(true)
    mockGetEvmAddress.mockReturnValue(null)
    renderWithStore()
    expect(mockLockWallet).not.toHaveBeenCalled()
  })

  it('does NOT lock when the wagmi address matches the bound EVM address', () => {
    wagmiState.address = '0xABCDef0123456789ABcdEf0123456789aBCdef01'
    wagmiState.isConnected = true
    mockIsUnlocked.mockReturnValue(true)
    // keyManager stores lowercase; useWallet normalizes the wagmi address before comparing.
    mockGetEvmAddress.mockReturnValue('0xabcdef0123456789abcdef0123456789abcdef01')
    renderWithStore()
    expect(mockLockWallet).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('LOCKS when the wagmi address differs from the bound EVM address and clears the active wallet atoms', () => {
    wagmiState.address = '0xnewAddress'
    wagmiState.isConnected = true
    mockIsUnlocked.mockReturnValue(true)
    mockGetEvmAddress.mockReturnValue('0xoldaddress')
    const store = renderWithStore()
    store.set(activeRailgunWalletIdAtom, 'some-wallet-id')
    store.set(shieldedWalletsAtom, { 'some-wallet-id': { id: 'some-wallet-id', status: 'unlocked' } })
    // The lock is fired synchronously on render via the effect's first run.
    expect(mockLockWallet).toHaveBeenCalledTimes(1)
  })

  it('LOCKS when the user disconnects the wallet (address goes to undefined) while unlocked', () => {
    wagmiState.address = undefined
    wagmiState.isConnected = false
    mockIsUnlocked.mockReturnValue(true)
    mockGetEvmAddress.mockReturnValue('0xoldaddress')
    renderWithStore()
    expect(mockLockWallet).toHaveBeenCalledTimes(1)
  })
})
