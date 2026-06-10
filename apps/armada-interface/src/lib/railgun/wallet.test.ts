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
  MismatchedRecoverySecretError,
} from './wallet'
import { isUnlocked, getWalletId, getRailgunAddress, clear as clearKeyManager } from './keyManager'
import { encryptBackup, deriveRootSecret } from '@/lib/crypto/kdf'

const mockCreate = createRailgunWallet as unknown as ReturnType<typeof vi.fn>
const mockLoad = loadWalletByID as unknown as ReturnType<typeof vi.fn>
const mockUnload = unloadWalletByID as unknown as ReturnType<typeof vi.fn>
const mockDelete = deleteWalletByID as unknown as ReturnType<typeof vi.fn>

const SAMPLE_WALLET_ID = '0d3a8e7c'
const SAMPLE_RAILGUN_ADDRESS = '0zk1qexample…'
const SAMPLE_EVM = '0xabcdef0123456789abcdef0123456789abcdef01' as `0x${string}`
const SAMPLE_EVM_LC = SAMPLE_EVM.toLowerCase()

// Helpers for seeding/reading the per-(EVM, account) localStorage map that wallet.ts uses now.
function seedStoredWalletId(walletId: string, evmAddress: `0x${string}` = SAMPLE_EVM, account = '0'): void {
  const key = 'armada.shielded.walletIds'
  const raw = window.localStorage.getItem(key)
  const map = raw ? JSON.parse(raw) : {}
  const evm = evmAddress.toLowerCase()
  map[evm] = { ...(map[evm] ?? {}), [account]: walletId }
  window.localStorage.setItem(key, JSON.stringify(map))
}
function seedStoredChecksum(checksum: string, evmAddress: `0x${string}` = SAMPLE_EVM, account = '0'): void {
  const key = 'armada.shielded.checksums'
  const raw = window.localStorage.getItem(key)
  const map = raw ? JSON.parse(raw) : {}
  const evm = evmAddress.toLowerCase()
  map[evm] = { ...(map[evm] ?? {}), [account]: checksum }
  window.localStorage.setItem(key, JSON.stringify(map))
}
function readStoredMap(key: string): Record<string, Record<string, string>> {
  const raw = window.localStorage.getItem(key)
  return raw ? JSON.parse(raw) : {}
}

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

  it('marks the keyManager unlocked + persists walletId to the per-(EVM,account) localStorage map', async () => {
    await enrollFromSignature(fixedSig(), { evmAddress: SAMPLE_EVM, account: 0n })
    expect(isUnlocked()).toBe(true)
    expect(getWalletId()).toBe(SAMPLE_WALLET_ID)
    expect(getRailgunAddress()).toBe(SAMPLE_RAILGUN_ADDRESS)
    const map = readStoredMap('armada.shielded.walletIds')
    expect(map[SAMPLE_EVM_LC]?.['0']).toBe(SAMPLE_WALLET_ID)
  })

  it('skips the localStorage binding when no evmAddress is supplied (no-wallet-connected fallback)', async () => {
    await enrollFromSignature(fixedSig())
    expect(isUnlocked()).toBe(true)
    expect(getWalletId()).toBe(SAMPLE_WALLET_ID)
    // No entries in the map because we didn't pass an evmAddress.
    expect(readStoredMap('armada.shielded.walletIds')).toEqual({})
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

  it('try-loads an existing SDK wallet when a walletId is cached for this (EVM,account) tuple', async () => {
    // Simulates "Sign in" on UnlockFlow's primary tab: same signature, but a walletId from a
    // prior session is already in the map. Must call loadWalletByID, not createRailgunWallet,
    // so the SDK preserves its scan cursor + UTXO set (otherwise shielded balance shows 0
    // after reload).
    seedStoredWalletId(SAMPLE_WALLET_ID)
    const { state } = await enrollFromSignature(fixedSig(), { evmAddress: SAMPLE_EVM, account: 0n })
    expect(mockLoad).toHaveBeenCalledTimes(1)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(state.id).toBe(SAMPLE_WALLET_ID)
    expect(state.railgunAddress).toBe(SAMPLE_RAILGUN_ADDRESS)
  })

  it('falls back to createRailgunWallet when the cached walletId fails to load (cleared IDB)', async () => {
    seedStoredWalletId(SAMPLE_WALLET_ID)
    mockLoad.mockRejectedValueOnce(new Error('Could not load RAILGUN wallet'))
    const { state } = await enrollFromSignature(fixedSig(), { evmAddress: SAMPLE_EVM, account: 0n })
    expect(mockLoad).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(state.id).toBe(SAMPLE_WALLET_ID)
  })

  it('zeroes the input signature buffer after HKDF derivation (signature-discipline guarantee)', async () => {
    // Per V2 amendment §"Signature discipline" — the caller's reference to the signature
    // buffer must point to all-zeros after enrollFromSignature returns, even on the happy
    // path. This is best-effort (JS gives no zeroization guarantees), but the in-place
    // .fill(0) closes the window during which a heap scrape could recover the bytes.
    const sig = fixedSig(0)
    // Sanity: the signature is non-zero going in, so the post-call assertion is meaningful.
    expect(Array.from(sig).some(b => b !== 0)).toBe(true)
    await enrollFromSignature(sig)
    expect(Array.from(sig).every(b => b === 0)).toBe(true)
  })

  it('zeroes the input signature buffer even when derivation throws (try/finally guarantee)', async () => {
    // A 64-byte input fails the length assertion inside deriveRootSecret. The signature
    // buffer must still be zeroed before the exception propagates.
    const badSig = new Uint8Array(64)
    for (let i = 0; i < 64; i++) badSig[i] = 0xab
    await expect(enrollFromSignature(badSig)).rejects.toThrow()
    expect(Array.from(badSig).every(b => b === 0)).toBe(true)
  })

  it('throws NonDeterministicSignerError when the re-sign derives a different identity than the cached one', async () => {
    // Simulate the post-Phase-2a returning-user determinism check: the previous session
    // stored a checksum for identity A; the user re-signs but the wallet now produces a
    // signature for identity B. The cached-checksum-mismatch guard catches this before any
    // identity is bound to the device, and surfaces a typed error the UI can render as a
    // dedicated screen (rather than a generic toast).
    seedStoredWalletId(SAMPLE_WALLET_ID)
    seedStoredChecksum('aaaa bbbb cccc') // identity A
    let captured: unknown
    try {
      await enrollFromSignature(fixedSig(0), { evmAddress: SAMPLE_EVM, account: 0n })
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

  it('the cached-checksum mismatch is scoped to (evmAddress, account) — a different EVM address gets a fresh enrollment, not a mismatch', async () => {
    // Phase 4 guarantee: switching EVM addresses lets a user enroll a fresh shielded identity
    // for the new address without tripping the cached-mismatch guard tied to the old address.
    seedStoredWalletId(SAMPLE_WALLET_ID, SAMPLE_EVM)
    seedStoredChecksum('aaaa bbbb cccc', SAMPLE_EVM)
    const otherEvm = '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`
    // Different EVM address → no entry for the (otherEvm, 0) tuple → fresh-create path runs.
    const { state } = await enrollFromSignature(fixedSig(0), { evmAddress: otherEvm, account: 0n })
    expect(state.id).toBe(SAMPLE_WALLET_ID)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

describe('unlockFromRootSecret', () => {
  it('fast-paths via loadWalletByID when a walletId is cached for the (EVM, account) tuple', async () => {
    seedStoredWalletId(SAMPLE_WALLET_ID)
    const root = deriveRootSecret(fixedSig())
    const state = await unlockFromRootSecret(root, { evmAddress: SAMPLE_EVM, account: 0n })

    expect(mockLoad).toHaveBeenCalledTimes(1)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(state.id).toBe(SAMPLE_WALLET_ID)
    expect(state.railgunAddress).toBe(SAMPLE_RAILGUN_ADDRESS)
    expect(state.checksum).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/)
    expect(isUnlocked()).toBe(true)
  })

  it('falls back to createRailgunWallet when loadWalletByID throws (wallet missing on this device)', async () => {
    seedStoredWalletId(SAMPLE_WALLET_ID)
    mockLoad.mockRejectedValueOnce(new Error('Could not load RAILGUN wallet'))
    const root = deriveRootSecret(fixedSig())
    const state = await unlockFromRootSecret(root, { evmAddress: SAMPLE_EVM, account: 0n })

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

  // P1-13: a wrong pasted secret (or a backup for a different wallet) must NOT silently rebind the
  // device. Refuse with a typed error and leave the binding maps untouched so the next correct
  // sign-in doesn't hit the scary cached-checksum-mismatch.
  it('refuses when the derived identity differs from the device binding, without rebinding', async () => {
    seedStoredChecksum('aaaa bbbb cccc') // device bound to a different identity for (EVM, account)
    const root = deriveRootSecret(fixedSig())

    await expect(
      unlockFromRootSecret(root, { evmAddress: SAMPLE_EVM, account: 0n }),
    ).rejects.toBeInstanceOf(MismatchedRecoverySecretError)

    // Binding maps untouched, no SDK work attempted, wallet stays locked.
    expect(readStoredMap('armada.shielded.checksums')[SAMPLE_EVM_LC]?.['0']).toBe('aaaa bbbb cccc')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockLoad).not.toHaveBeenCalled()
    expect(isUnlocked()).toBe(false)
  })

  it('unlocks + writes the binding on a fresh device (no stored checksum)', async () => {
    const root = deriveRootSecret(fixedSig())
    const state = await unlockFromRootSecret(root, { evmAddress: SAMPLE_EVM, account: 0n })
    expect(isUnlocked()).toBe(true)
    expect(readStoredMap('armada.shielded.checksums')[SAMPLE_EVM_LC]?.['0']).toBe(state.checksum)
  })

  it('unlocks when the pasted secret matches the device binding (re-paste of the same secret)', async () => {
    const first = await unlockFromRootSecret(deriveRootSecret(fixedSig()), { evmAddress: SAMPLE_EVM, account: 0n })
    clearKeyManager()
    const again = await unlockFromRootSecret(deriveRootSecret(fixedSig()), { evmAddress: SAMPLE_EVM, account: 0n })
    expect(again.checksum).toBe(first.checksum)
    expect(isUnlocked()).toBe(true)
  })
})

describe('unlockFromBackup', () => {
  it('decrypts the backup blob and unlocks', async () => {
    const root = deriveRootSecret(fixedSig())
    const blob = await encryptBackup({ rootSecret: root, creationBlock: 0 }, 'passphrase-here', { iterations: 1000 })
    const state = await unlockFromBackup(blob, 'passphrase-here')
    expect(state.status).toBe('unlocked')
    expect(state.id).toBe(SAMPLE_WALLET_ID)
    expect(isUnlocked()).toBe(true)
  })

  it('propagates the authentication error when the passphrase is wrong', async () => {
    const root = deriveRootSecret(fixedSig())
    const blob = await encryptBackup({ rootSecret: root, creationBlock: 0 }, 'right-here', { iterations: 1000 })
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
  it('deletes the SDK wallet and clears the entire per-(EVM,account) map', async () => {
    await enrollFromSignature(fixedSig(), { evmAddress: SAMPLE_EVM, account: 0n })
    expect(readStoredMap('armada.shielded.walletIds')[SAMPLE_EVM_LC]?.['0']).toBe(SAMPLE_WALLET_ID)
    await resetWallet('whatever-id-arg-is-ignored')
    expect(mockDelete).toHaveBeenCalledWith(SAMPLE_WALLET_ID)
    expect(window.localStorage.getItem('armada.shielded.walletIds')).toBeNull()
    expect(window.localStorage.getItem('armada.shielded.checksums')).toBeNull()
    expect(isUnlocked()).toBe(false)
  })

  it('throws when there is nothing to reset (no unlocked session + no cached id)', async () => {
    await expect(resetWallet('whatever')).rejects.toThrow(/no wallet to reset/)
  })

  it('uses the cached walletId when locked but a previous session left state', async () => {
    seedStoredWalletId('cached-id-xyz')
    await resetWallet('whatever')
    expect(mockDelete).toHaveBeenCalledWith('cached-id-xyz')
    expect(window.localStorage.getItem('armada.shielded.walletIds')).toBeNull()
  })

  it('still clears localStorage even if SDK delete throws', async () => {
    await enrollFromSignature(fixedSig(), { evmAddress: SAMPLE_EVM, account: 0n })
    mockDelete.mockRejectedValueOnce(new Error('wallet not found'))
    await resetWallet('whatever')
    expect(window.localStorage.getItem('armada.shielded.walletIds')).toBeNull()
  })
})
