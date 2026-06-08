// ABOUTME: Tests for useShieldedWallet — enroll/unlockByPaste/unlockByBackup/exportBackup/lock/reset.
// ABOUTME: Mocks lib/railgun/wallet at the import boundary so we don't need a live engine; wagmi useSignTypedData is mocked to return a deterministic signature.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { useShieldedWallet } from './useShieldedWallet'
import {
  activeRailgunWalletIdAtom,
  evmAddressAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'
import type { ShieldedWalletState } from '@/lib/railgun/wallet'

// Mock the lib boundary so we never touch the Railgun SDK + circomlibjs in jsdom.
vi.mock('@/lib/railgun/wallet', () => ({
  enrollFromSignature: vi.fn(),
  unlockFromRootSecret: vi.fn(),
  unlockFromBackup: vi.fn(),
  lockWallet: vi.fn(async () => {}),
  resetWallet: vi.fn(async () => {}),
  // Deprecated shims — present so the hook compiles; never exercised here.
  createWallet: vi.fn(),
  unlockWallet: vi.fn(),
  exportMnemonic: vi.fn(),
}))

vi.mock('@/lib/railgun/keyManager', () => ({
  getRootSecret: vi.fn(),
  getCreationBlock: vi.fn(() => null),
}))

// Mock the imperative wagmi action. The hook calls `signTypedData(wagmiConfig, args)` directly —
// no React context required, no provider tree needed in consumer tests.
vi.mock('wagmi/actions', () => ({
  signTypedData: vi.fn(),
}))

import {
  enrollFromSignature,
  unlockFromRootSecret,
  unlockFromBackup,
  lockWallet,
  resetWallet,
} from '@/lib/railgun/wallet'
import { getRootSecret } from '@/lib/railgun/keyManager'
import { signTypedData } from 'wagmi/actions'

const mockEnroll = enrollFromSignature as unknown as ReturnType<typeof vi.fn>
const mockUnlockFromRoot = unlockFromRootSecret as unknown as ReturnType<typeof vi.fn>
const mockUnlockFromBackup = unlockFromBackup as unknown as ReturnType<typeof vi.fn>
const mockLockWallet = lockWallet as unknown as ReturnType<typeof vi.fn>
const mockResetWallet = resetWallet as unknown as ReturnType<typeof vi.fn>
const mockGetRootSecret = getRootSecret as unknown as ReturnType<typeof vi.fn>
const mockSignTypedData = signTypedData as unknown as ReturnType<typeof vi.fn>

// Deterministic 65-byte sample sig hex (r||s||v with v=27). The exact value doesn't matter —
// the mocked enrollFromSignature ignores it; what matters is that normalizeSignature accepts it.
const SAMPLE_SIG_HEX = '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b'
const SAMPLE_STATE: ShieldedWalletState = {
  id: 'wallet-id-1',
  status: 'unlocked',
  railgunAddress: '0zk1qexample',
  checksum: 'a3f2 91c8 b7e0',
  unlockedAt: 1700000000000,
}

interface CaptureHandle {
  current: ReturnType<typeof useShieldedWallet> | null
}

function Harness({ capture }: { capture: CaptureHandle }) {
  capture.current = useShieldedWallet()
  return null
}

function renderWithStore(store: ReturnType<typeof createStore>) {
  const capture: CaptureHandle = { current: null }
  render(
    <Provider store={store}>
      <Harness capture={capture} />
    </Provider>,
  )
  return capture
}

beforeEach(() => {
  mockEnroll.mockReset()
  mockUnlockFromRoot.mockReset()
  mockUnlockFromBackup.mockReset()
  mockLockWallet.mockReset()
  mockResetWallet.mockReset()
  mockGetRootSecret.mockReset()
  mockSignTypedData.mockReset()
  // Default: wagmi returns a successful signature.
  mockSignTypedData.mockResolvedValue(SAMPLE_SIG_HEX)
  mockLockWallet.mockResolvedValue(undefined)
  mockResetWallet.mockResolvedValue(undefined)
})

describe('enroll', () => {
  it('signs, derives, and mirrors the resulting state into atoms', async () => {
    const store = createStore()
    store.set(evmAddressAtom, '0xabc')
    mockEnroll.mockResolvedValueOnce({
      rootSecret: new Uint8Array(32),
      state: SAMPLE_STATE,
    })
    const capture = renderWithStore(store)

    let result: { rootSecret: Uint8Array; state: ShieldedWalletState } | undefined
    await act(async () => {
      result = await capture.current!.enroll()
    })

    expect(mockEnroll).toHaveBeenCalledTimes(1)
    expect(result!.state.id).toBe('wallet-id-1')
    expect(store.get(shieldedWalletsAtom)['wallet-id-1']).toEqual(SAMPLE_STATE)
    expect(store.get(activeRailgunWalletIdAtom)).toBe('wallet-id-1')
  })

  it('rejects when no EVM wallet is connected', async () => {
    const store = createStore()
    store.set(evmAddressAtom, null)
    const capture = renderWithStore(store)

    await expect(capture.current!.enroll()).rejects.toThrow(/Connect an EVM wallet/)
    expect(mockEnroll).not.toHaveBeenCalled()
  })

  it('propagates wagmi sign rejection (user rejected in MetaMask)', async () => {
    const store = createStore()
    store.set(evmAddressAtom, '0xabc')
    mockSignTypedData.mockRejectedValueOnce(new Error('User rejected the request.'))
    const capture = renderWithStore(store)

    await expect(capture.current!.enroll()).rejects.toThrow(/rejected/)
    expect(mockEnroll).not.toHaveBeenCalled()
  })
})

describe('signIn (v2 primary)', () => {
  it('signs the EIP-712 message and mirrors the resulting state into atoms', async () => {
    const store = createStore()
    store.set(evmAddressAtom, '0xabc')
    mockEnroll.mockResolvedValueOnce({
      rootSecret: new Uint8Array(32),
      state: SAMPLE_STATE,
    })
    const capture = renderWithStore(store)

    let result: { rootSecret: Uint8Array; state: ShieldedWalletState } | undefined
    await act(async () => {
      result = await capture.current!.signIn()
    })

    expect(mockSignTypedData).toHaveBeenCalledTimes(1)
    expect(mockEnroll).toHaveBeenCalledTimes(1)
    expect(result!.state.id).toBe('wallet-id-1')
    expect(store.get(activeRailgunWalletIdAtom)).toBe('wallet-id-1')
  })

  it('defaults the account index to 0 in the signed message', async () => {
    const store = createStore()
    store.set(evmAddressAtom, '0xabc')
    mockEnroll.mockResolvedValueOnce({ rootSecret: new Uint8Array(32), state: SAMPLE_STATE })
    const capture = renderWithStore(store)

    await act(async () => {
      await capture.current!.signIn()
    })

    const args = mockSignTypedData.mock.calls[0]?.[1] as { message: { account: string } } | undefined
    expect(args?.message.account).toBe('0')
  })

  it('threads a non-zero account index through to the signed message', async () => {
    const store = createStore()
    store.set(evmAddressAtom, '0xabc')
    mockEnroll.mockResolvedValueOnce({ rootSecret: new Uint8Array(32), state: SAMPLE_STATE })
    const capture = renderWithStore(store)

    await act(async () => {
      await capture.current!.signIn(7n)
    })

    const args = mockSignTypedData.mock.calls[0]?.[1] as { message: { account: string } } | undefined
    expect(args?.message.account).toBe('7')
  })

  it('rejects when no EVM wallet is connected', async () => {
    const store = createStore()
    store.set(evmAddressAtom, null)
    const capture = renderWithStore(store)

    await expect(capture.current!.signIn()).rejects.toThrow(/Connect an EVM wallet/)
    expect(mockSignTypedData).not.toHaveBeenCalled()
  })

  it('enroll() is a thin alias for signIn(0n) — same behaviour, same outputs', async () => {
    const store = createStore()
    store.set(evmAddressAtom, '0xabc')
    mockEnroll.mockResolvedValue({ rootSecret: new Uint8Array(32), state: SAMPLE_STATE })
    const capture = renderWithStore(store)

    await act(async () => {
      await capture.current!.enroll()
    })

    const args = mockSignTypedData.mock.calls[0]?.[1] as { message: { account: string } } | undefined
    expect(args?.message.account).toBe('0')
  })
})

describe('unlockByPaste', () => {
  it('parses 64-hex input (with 0x prefix) and unlocks', async () => {
    const store = createStore()
    mockUnlockFromRoot.mockResolvedValueOnce(SAMPLE_STATE)
    const capture = renderWithStore(store)

    await act(async () => {
      await capture.current!.unlockByPaste('0x' + 'ab'.repeat(32))
    })

    expect(mockUnlockFromRoot).toHaveBeenCalledTimes(1)
    const bytesArg = mockUnlockFromRoot.mock.calls[0]![0] as Uint8Array
    // We zero out our own copy in finally — but the SDK call already happened with the original
    // contents. Check that exactly 32 bytes were passed (entropy floor canary asserts contents).
    expect(bytesArg.length).toBe(32)
    expect(store.get(shieldedWalletsAtom)['wallet-id-1']).toEqual(SAMPLE_STATE)
  })

  it('also accepts input without 0x prefix', async () => {
    const store = createStore()
    mockUnlockFromRoot.mockResolvedValueOnce(SAMPLE_STATE)
    const capture = renderWithStore(store)

    await act(async () => {
      await capture.current!.unlockByPaste('cd'.repeat(32))
    })
    expect(mockUnlockFromRoot).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid hex input', async () => {
    const store = createStore()
    const capture = renderWithStore(store)

    await expect(capture.current!.unlockByPaste('not hex')).rejects.toThrow(/64 hexadecimal/)
    await expect(capture.current!.unlockByPaste('ab'.repeat(31))).rejects.toThrow(/64 hexadecimal/)
    expect(mockUnlockFromRoot).not.toHaveBeenCalled()
  })
})

describe('unlockByBackup', () => {
  it('reads the file, parses JSON, validates blob shape, and unlocks', async () => {
    const store = createStore()
    mockUnlockFromBackup.mockResolvedValueOnce(SAMPLE_STATE)
    const capture = renderWithStore(store)

    const validBlob = {
      format: 'armada-backup-v2',
      kdf: 'pbkdf2-sha256',
      kdf_params: { iterations: 600000 },
      kdf_salt: 'aa'.repeat(32),
      cipher: 'aes-256-gcm',
      nonce: 'bb'.repeat(12),
      // v2 plaintext is 40 bytes (32 rootSecret + 8 creationBlock BE) → 80 hex chars.
      // (v1 with a 32-byte / 64-hex ciphertext is also accepted; see kdf.test.ts for that path.)
      ciphertext: 'cc'.repeat(40),
      tag: 'dd'.repeat(16),
    }
    const file = new File([JSON.stringify(validBlob)], 'armada-backup.json', {
      type: 'application/json',
    })

    await act(async () => {
      await capture.current!.unlockByBackup(file, 'passphrase-here')
    })

    expect(mockUnlockFromBackup).toHaveBeenCalledTimes(1)
    expect(store.get(activeRailgunWalletIdAtom)).toBe('wallet-id-1')
  })

  it('rejects malformed JSON', async () => {
    const store = createStore()
    const capture = renderWithStore(store)

    const badFile = new File(['{not valid json'], 'armada-backup.json')
    await expect(capture.current!.unlockByBackup(badFile, 'whatever')).rejects.toThrow(
      /not valid JSON/,
    )
  })

  it('rejects valid JSON that isn’t a backup blob', async () => {
    const store = createStore()
    const capture = renderWithStore(store)

    const wrongShape = new File([JSON.stringify({ hello: 'world' })], 'bogus.json')
    await expect(capture.current!.unlockByBackup(wrongShape, 'whatever')).rejects.toThrow()
    expect(mockUnlockFromBackup).not.toHaveBeenCalled()
  })
})

describe('exportBackup', () => {
  it('reads root_secret from the keyManager and returns an encrypted blob', async () => {
    const store = createStore()
    store.set(shieldedWalletsAtom, { [SAMPLE_STATE.id]: SAMPLE_STATE })
    store.set(activeRailgunWalletIdAtom, SAMPLE_STATE.id)
    const rootSecret = new Uint8Array(32)
    for (let i = 0; i < 32; i++) rootSecret[i] = i + 1
    mockGetRootSecret.mockReturnValueOnce(rootSecret)
    const capture = renderWithStore(store)

    let blob: { format: string; ciphertext: string } | undefined
    await act(async () => {
      blob = await capture.current!.exportBackup('passphrase-here')
    })

    expect(blob!.format).toBe('armada-backup-v2')
    expect(blob!.ciphertext.length).toBe(80) // v2: 40-byte plaintext → 80 hex chars
    expect(mockGetRootSecret).toHaveBeenCalledTimes(1)
  })

  it('propagates the locked-state error from the keyManager', async () => {
    const store = createStore()
    mockGetRootSecret.mockImplementation(() => {
      throw new Error('wallet is locked')
    })
    const capture = renderWithStore(store)

    await expect(capture.current!.exportBackup('passphrase-here')).rejects.toThrow(/locked/)
  })
})

describe('lock', () => {
  it('calls lockWallet and flips the atom entry to locked', async () => {
    const store = createStore()
    store.set(shieldedWalletsAtom, { [SAMPLE_STATE.id]: SAMPLE_STATE })
    store.set(activeRailgunWalletIdAtom, SAMPLE_STATE.id)
    const capture = renderWithStore(store)

    await act(async () => {
      await capture.current!.lock()
    })

    expect(mockLockWallet).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(store.get(shieldedWalletsAtom)[SAMPLE_STATE.id]?.status).toBe('locked')
    })
  })

  it('is a no-op when there is no active wallet', async () => {
    const store = createStore()
    const capture = renderWithStore(store)

    await act(async () => {
      await capture.current!.lock()
    })
    expect(mockLockWallet).not.toHaveBeenCalled()
  })
})

describe('reset', () => {
  it('calls resetWallet and clears the entry from atoms', async () => {
    const store = createStore()
    store.set(shieldedWalletsAtom, { [SAMPLE_STATE.id]: SAMPLE_STATE })
    store.set(activeRailgunWalletIdAtom, SAMPLE_STATE.id)
    const capture = renderWithStore(store)

    await act(async () => {
      await capture.current!.reset()
    })

    expect(mockResetWallet).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(store.get(shieldedWalletsAtom)[SAMPLE_STATE.id]).toBeUndefined()
      expect(store.get(activeRailgunWalletIdAtom)).toBeNull()
    })
  })
})
