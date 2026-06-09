// ABOUTME: Tests for lib/railgun/wallet — enroll/unlock/lock/reset paths with a mocked Railgun SDK.
// ABOUTME: Real engine init is exercised in commit 3 (init.ts port); here we verify our wallet.ts plumbs the SDK calls + keyManager correctly.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Railgun SDK at the module boundary so we don't need a live engine to test our wrapper.
// We capture the per-test mock impls below for assertion.
vi.mock('@railgun-community/wallet', () => ({
  createRailgunWallet: vi.fn(),
  loadWalletByID: vi.fn(),
  unloadWalletByID: vi.fn(),
  deleteWalletByID: vi.fn(),
}))

// Also mock our engine bootstrap modules — they eagerly import the SDK at top-level, which
// would trigger jsdom's circomlibjs init crash. Tests for these modules will live alongside
// them (init.test.ts / network.test.ts) once the engine plumbing has a real test surface.
vi.mock('./init', () => ({
  initRailgunEngine: vi.fn(async () => {}),
  isRailgunEngineInitialized: vi.fn(() => true),
  getRailgunInitError: vi.fn(() => null),
  resetInitState: vi.fn(),
}))
vi.mock('./network', () => ({
  loadHubNetwork: vi.fn(async () => {}),
  isHubNetworkLoaded: vi.fn(() => true),
  resetNetworkLoaderState: vi.fn(),
  getHubChainDescriptor: vi.fn(() => ({ type: 0 as const, id: 31337 })),
  // Returns null so wallet.ts passes undefined to createRailgunWallet — same as the prior
  // behavior before Phase 1.4 added creationBlockNumbers wiring. Tests don't exercise the
  // creation-block side of things; that's a runtime optimization verified on testnet.
  getCurrentHubBlock: vi.fn(async () => null),
}))

import {
  createRailgunWallet,
  loadWalletByID,
  unloadWalletByID,
  deleteWalletByID,
} from '@railgun-community/wallet'
import {
  enrollFromSignature,
  unlockFromRootSecret,
  unlockFromBackup,
  lockWallet,
  resetWallet,
} from './wallet'
import { isUnlocked, getWalletId, getRailgunAddress, clear as clearKeyManager } from './keyManager'
import { encryptBackup, deriveRootSecret } from '@/lib/crypto/kdf'

const mockCreate = createRailgunWallet as unknown as ReturnType<typeof vi.fn>
const mockLoad = loadWalletByID as unknown as ReturnType<typeof vi.fn>
const mockUnload = unloadWalletByID as unknown as ReturnType<typeof vi.fn>
const mockDelete = deleteWalletByID as unknown as ReturnType<typeof vi.fn>

const SAMPLE_WALLET_ID = '0d3a8e7c'
const SAMPLE_RAILGUN_ADDRESS = '0zk1qexample…'

function fixedSig(seed = 0): Uint8Array {
  const out = new Uint8Array(65)
  for (let i = 0; i < 64; i++) out[i] = (seed + i) & 0xff
  out[64] = 27
  return out
}

beforeEach(() => {
  mockCreate.mockReset()
  mockLoad.mockReset()
  mockUnload.mockReset()
  mockDelete.mockReset()
  clearKeyManager()
  window.localStorage.clear()

  // Default happy path: createRailgunWallet returns a fixed wallet info.
  mockCreate.mockResolvedValue({ id: SAMPLE_WALLET_ID, railgunAddress: SAMPLE_RAILGUN_ADDRESS })
  mockLoad.mockResolvedValue({ id: SAMPLE_WALLET_ID, railgunAddress: SAMPLE_RAILGUN_ADDRESS })
})

describe('enrollFromSignature', () => {
  it('derives root_secret from the normalized signature and creates an SDK wallet', async () => {
    const sig = fixedSig()
    const { rootSecret, state } = await enrollFromSignature(sig)

    expect(rootSecret.length).toBe(32)
    expect(state.id).toBe(SAMPLE_WALLET_ID)
    expect(state.status).toBe('unlocked')
    expect(state.railgunAddress).toBe(SAMPLE_RAILGUN_ADDRESS)
    expect(state.checksum).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/)
    expect(state.unlockedAt).toBeTypeOf('number')

    // SDK was called with (encryptionKey, mnemonic, undefined, 0) — derivationIndex = 0.
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const args = mockCreate.mock.calls[0]!
    expect(args[0]).toMatch(/^[0-9a-f]{64}$/) // encryption key — 64 hex chars
    expect(typeof args[1]).toBe('string') // mnemonic
    expect((args[1] as string).split(' ').length).toBe(24)
    expect(args[2]).toBeUndefined() // creationBlockNumbers
    expect(args[3]).toBe(0) // derivation index
  })

  it('marks the keyManager unlocked + persists walletId to localStorage', async () => {
    await enrollFromSignature(fixedSig())
    expect(isUnlocked()).toBe(true)
    expect(getWalletId()).toBe(SAMPLE_WALLET_ID)
    expect(getRailgunAddress()).toBe(SAMPLE_RAILGUN_ADDRESS)
    expect(window.localStorage.getItem('armada.shielded.walletId')).toBe(SAMPLE_WALLET_ID)
  })

  it('is deterministic — same signature → same root_secret → same checksum', async () => {
    const a = await enrollFromSignature(fixedSig(0))
    // Snapshot a.rootSecret BEFORE clearKeyManager() zeroizes it — both `a` and the keyManager
    // share the buffer reference (intentional, see keyManager.setUnlocked docs).
    const aRootCopy = new Uint8Array(a.rootSecret)
    const aChecksum = a.state.checksum
    clearKeyManager()
    window.localStorage.clear()
    mockCreate.mockClear()
    const b = await enrollFromSignature(fixedSig(0))
    expect(b.state.checksum).toBe(aChecksum)
    expect(b.rootSecret).toEqual(aRootCopy)
  })

  it('different signatures produce different checksums', async () => {
    const a = await enrollFromSignature(fixedSig(0))
    clearKeyManager()
    window.localStorage.clear()
    const b = await enrollFromSignature(fixedSig(1))
    expect(b.state.checksum).not.toBe(a.state.checksum)
  })

  it('rejects signatures of the wrong length', async () => {
    await expect(enrollFromSignature(new Uint8Array(64))).rejects.toThrow()
  })

  it('try-loads an existing SDK wallet when a walletId is cached in localStorage', async () => {
    // Simulates "Sign again" on UnlockFlow: same signature, but a walletId from a prior session
    // is already persisted. Must call loadWalletByID, not createRailgunWallet, so the SDK
    // preserves its scan cursor + UTXO set (otherwise shielded balance shows 0 after reload).
    window.localStorage.setItem('armada.shielded.walletId', SAMPLE_WALLET_ID)
    const { state } = await enrollFromSignature(fixedSig())
    expect(mockLoad).toHaveBeenCalledTimes(1)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(state.id).toBe(SAMPLE_WALLET_ID)
    expect(state.railgunAddress).toBe(SAMPLE_RAILGUN_ADDRESS)
  })

  it('falls back to createRailgunWallet when the cached walletId fails to load (cleared IDB)', async () => {
    window.localStorage.setItem('armada.shielded.walletId', SAMPLE_WALLET_ID)
    mockLoad.mockRejectedValueOnce(new Error('Could not load RAILGUN wallet'))
    const { state } = await enrollFromSignature(fixedSig())
    expect(mockLoad).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(state.id).toBe(SAMPLE_WALLET_ID)
  })

  it('throws NonDeterministicSignerError when the re-sign derives a different identity than the cached one', async () => {
    // Simulate the post-Phase-2a returning-user determinism check: the previous session
    // stored a checksum for identity A; the user re-signs but the wallet now produces a
    // signature for identity B. The cached-checksum-mismatch guard catches this before any
    // identity is bound to the device, and surfaces a typed error the UI can render as a
    // dedicated screen (rather than a generic toast).
    window.localStorage.setItem('armada.shielded.walletId', SAMPLE_WALLET_ID)
    window.localStorage.setItem('armada.shielded.checksum', 'aaaa bbbb cccc') // identity A
    let captured: unknown
    try {
      await enrollFromSignature(fixedSig(0)) // derives a checksum that won't match 'aaaa bbbb cccc'
    } catch (err) {
      captured = err
    }
    expect(captured).toBeDefined()
    const errObj = captured as { kind?: string; reason?: string }
    expect(errObj.kind).toBe('NonDeterministicSignerError')
    expect(errObj.reason).toBe('cached-checksum-mismatch')
    // Critical: must NOT have called the SDK at all (no wallet bound on this device).
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockLoad).not.toHaveBeenCalled()
  })
})

describe('unlockFromRootSecret', () => {
  it('fast-paths via loadWalletByID when a walletId is cached in localStorage', async () => {
    window.localStorage.setItem('armada.shielded.walletId', SAMPLE_WALLET_ID)
    const root = deriveRootSecret(fixedSig())
    const state = await unlockFromRootSecret(root)

    expect(mockLoad).toHaveBeenCalledTimes(1)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(state.id).toBe(SAMPLE_WALLET_ID)
    expect(state.railgunAddress).toBe(SAMPLE_RAILGUN_ADDRESS)
    expect(state.checksum).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/)
    expect(isUnlocked()).toBe(true)
  })

  it('falls back to createRailgunWallet when loadWalletByID throws (wallet missing on this device)', async () => {
    window.localStorage.setItem('armada.shielded.walletId', SAMPLE_WALLET_ID)
    mockLoad.mockRejectedValueOnce(new Error('Could not load RAILGUN wallet'))
    const root = deriveRootSecret(fixedSig())
    const state = await unlockFromRootSecret(root)

    expect(mockLoad).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(state.id).toBe(SAMPLE_WALLET_ID)
  })

  it('creates a fresh wallet when no walletId is cached', async () => {
    const root = deriveRootSecret(fixedSig())
    const state = await unlockFromRootSecret(root)

    expect(mockLoad).not.toHaveBeenCalled()
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(state.id).toBe(SAMPLE_WALLET_ID)
  })

  it('rejects rootSecret of the wrong length', async () => {
    await expect(unlockFromRootSecret(new Uint8Array(16))).rejects.toThrow()
  })
})

describe('unlockFromBackup', () => {
  it('decrypts the backup blob and unlocks', async () => {
    const root = deriveRootSecret(fixedSig())
    const blob = encryptBackup({ rootSecret: root, creationBlock: 0 }, 'passphrase-here', { iterations: 1000 })
    const state = await unlockFromBackup(blob, 'passphrase-here')
    expect(state.status).toBe('unlocked')
    expect(state.id).toBe(SAMPLE_WALLET_ID)
    expect(isUnlocked()).toBe(true)
  })

  it('propagates the authentication error when the passphrase is wrong', async () => {
    const root = deriveRootSecret(fixedSig())
    const blob = encryptBackup({ rootSecret: root, creationBlock: 0 }, 'right-here', { iterations: 1000 })
    await expect(unlockFromBackup(blob, 'wrong-here')).rejects.toThrow(/authentication failed/)
  })
})

describe('lockWallet', () => {
  it('clears the keyManager and calls SDK unloadWalletByID', async () => {
    await enrollFromSignature(fixedSig())
    expect(isUnlocked()).toBe(true)
    await lockWallet('whatever-id-arg-is-ignored')
    expect(isUnlocked()).toBe(false)
    expect(mockUnload).toHaveBeenCalledWith(SAMPLE_WALLET_ID)
  })

  it('is a no-op when no wallet is unlocked', async () => {
    expect(isUnlocked()).toBe(false)
    await lockWallet('whatever')
    expect(mockUnload).not.toHaveBeenCalled()
  })
})

describe('resetWallet', () => {
  it('deletes the SDK wallet and clears the cached walletId', async () => {
    await enrollFromSignature(fixedSig())
    expect(window.localStorage.getItem('armada.shielded.walletId')).toBe(SAMPLE_WALLET_ID)
    await resetWallet('whatever-id-arg-is-ignored')
    expect(mockDelete).toHaveBeenCalledWith(SAMPLE_WALLET_ID)
    expect(window.localStorage.getItem('armada.shielded.walletId')).toBeNull()
    expect(isUnlocked()).toBe(false)
  })

  it('throws when there is nothing to reset (no unlocked session + no cached id)', async () => {
    await expect(resetWallet('whatever')).rejects.toThrow(/no wallet to reset/)
  })

  it('uses the cached walletId when locked but a previous session left state', async () => {
    window.localStorage.setItem('armada.shielded.walletId', 'cached-id-xyz')
    await resetWallet('whatever')
    expect(mockDelete).toHaveBeenCalledWith('cached-id-xyz')
    expect(window.localStorage.getItem('armada.shielded.walletId')).toBeNull()
  })

  it('still clears localStorage even if SDK delete throws', async () => {
    await enrollFromSignature(fixedSig())
    mockDelete.mockRejectedValueOnce(new Error('wallet not found'))
    await resetWallet('whatever')
    expect(window.localStorage.getItem('armada.shielded.walletId')).toBeNull()
  })
})
