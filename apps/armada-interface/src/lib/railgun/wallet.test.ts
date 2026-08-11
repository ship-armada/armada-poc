// ABOUTME: Tests for lib/railgun/wallet — enroll/unlock/lock/reset. Identity is derived locally now
// ABOUTME: (deriveWalletId + the SDK's deriveKeyset 0zk); no stock engine. We verify the keyManager + localStorage plumbing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  railgunAddress: '0zk1qexampleaddressvalue00000000000000000000000000000000000000000000',
  deriveKeyset: vi.fn(),
  deleteSdkReadStorage: vi.fn(async () => {}),
}))

// Identity comes from the SDK's keyset derivation (mocked — the real one needs poseidon/ed25519 init,
// and this suite tests the wallet.ts lifecycle plumbing, not the crypto).
vi.mock('@armada/sdk', () => ({ deriveKeyset: h.deriveKeyset }))
// Reset wipes the SDK read instance's IDB scan state.
vi.mock('./sdk-read', () => ({ deleteSdkReadStorage: h.deleteSdkReadStorage }))
// wallet.ts only reads the current hub block (creation-block seed); return null so it's undefined.
vi.mock('./network', () => ({ getCurrentHubBlock: vi.fn(async () => null) }))

import {
  enrollFromSignature,
  unlockFromRootSecret,
  unlockFromBackup,
  lockWallet,
  resetWallet,
  MismatchedRecoverySecretError,
} from './wallet'
import { isUnlocked, getWalletId, getRailgunAddress, clear as clearKeyManager } from './keyManager'
import { encryptBackup, deriveRootSecret, deriveWalletId } from '@/lib/crypto/kdf'

const SAMPLE_EVM = '0xabcdef0123456789abcdef0123456789abcdef01' as `0x${string}`
const SAMPLE_EVM_LC = SAMPLE_EVM.toLowerCase()

/** The deterministic walletId wallet.ts derives for a given signature seed. */
function expectedWalletId(seed = 0): string {
  return deriveWalletId(deriveRootSecret(fixedSig(seed)))
}

function seedStoredWalletId(walletId: string, evmAddress: `0x${string}` = SAMPLE_EVM, account = '0'): void {
  const key = 'armada.shielded.walletIds'
  const raw = window.localStorage.getItem(key)
  const map = raw ? JSON.parse(raw) : {}
  map[evmAddress.toLowerCase()] = { ...(map[evmAddress.toLowerCase()] ?? {}), [account]: walletId }
  window.localStorage.setItem(key, JSON.stringify(map))
}
function seedStoredChecksum(checksum: string, evmAddress: `0x${string}` = SAMPLE_EVM, account = '0'): void {
  const key = 'armada.shielded.checksums'
  const raw = window.localStorage.getItem(key)
  const map = raw ? JSON.parse(raw) : {}
  map[evmAddress.toLowerCase()] = { ...(map[evmAddress.toLowerCase()] ?? {}), [account]: checksum }
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
  clearKeyManager()
  window.localStorage.clear()
  h.deriveKeyset.mockReset()
  h.deriveKeyset.mockResolvedValue({ railgunAddress: h.railgunAddress })
  h.deleteSdkReadStorage.mockClear()
})

describe('enrollFromSignature', () => {
  it('derives a deterministic identity (walletId + 0zk) from the signature, no engine wallet', async () => {
    const sig = fixedSig()
    const { rootSecret, state } = await enrollFromSignature(sig)

    expect(rootSecret.length).toBe(32)
    expect(state.id).toBe(expectedWalletId())
    expect(state.id).toMatch(/^[0-9a-f]{32}$/) // 16-byte HKDF wallet id
    expect(state.status).toBe('unlocked')
    expect(state.railgunAddress).toBe(h.railgunAddress)
    expect(state.checksum).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/)
    expect(state.unlockedAt).toBeTypeOf('number')
    expect(h.deriveKeyset).toHaveBeenCalledTimes(1)
  })

  it('marks the keyManager unlocked + persists walletId to the per-(EVM,account) localStorage map', async () => {
    await enrollFromSignature(fixedSig(), { evmAddress: SAMPLE_EVM, account: 0n })
    expect(isUnlocked()).toBe(true)
    expect(getWalletId()).toBe(expectedWalletId())
    expect(getRailgunAddress()).toBe(h.railgunAddress)
    expect(readStoredMap('armada.shielded.walletIds')[SAMPLE_EVM_LC]?.['0']).toBe(expectedWalletId())
  })

  it('skips the localStorage binding when no evmAddress is supplied', async () => {
    await enrollFromSignature(fixedSig())
    expect(isUnlocked()).toBe(true)
    expect(readStoredMap('armada.shielded.walletIds')).toEqual({})
  })

  it('is deterministic — same signature → same root_secret → same id + checksum', async () => {
    const a = await enrollFromSignature(fixedSig(0))
    const aRootCopy = new Uint8Array(a.rootSecret)
    const aChecksum = a.state.checksum
    const aId = a.state.id
    clearKeyManager()
    window.localStorage.clear()
    const b = await enrollFromSignature(fixedSig(0))
    expect(b.state.checksum).toBe(aChecksum)
    expect(b.state.id).toBe(aId)
    expect(b.rootSecret).toEqual(aRootCopy)
  })

  it('different signatures produce different ids + checksums', async () => {
    const a = await enrollFromSignature(fixedSig(0))
    clearKeyManager()
    window.localStorage.clear()
    const b = await enrollFromSignature(fixedSig(1))
    expect(b.state.checksum).not.toBe(a.state.checksum)
    expect(b.state.id).not.toBe(a.state.id)
  })

  it('rejects signatures of the wrong length', async () => {
    await expect(enrollFromSignature(new Uint8Array(64))).rejects.toThrow()
  })

  it('zeroes the input signature buffer after HKDF derivation', async () => {
    const sig = fixedSig(0)
    expect(Array.from(sig).some((b) => b !== 0)).toBe(true)
    await enrollFromSignature(sig)
    expect(Array.from(sig).every((b) => b === 0)).toBe(true)
  })

  it('zeroes the input signature buffer even when derivation throws (try/finally guarantee)', async () => {
    const badSig = new Uint8Array(64)
    for (let i = 0; i < 64; i++) badSig[i] = 0xab
    await expect(enrollFromSignature(badSig)).rejects.toThrow()
    expect(Array.from(badSig).every((b) => b === 0)).toBe(true)
  })

  it('throws NonDeterministicSignerError when the re-sign derives a different identity than the cached one', async () => {
    seedStoredWalletId(expectedWalletId())
    seedStoredChecksum('aaaa bbbb cccc') // identity A — differs from the signature's derived checksum
    let captured: unknown
    try {
      await enrollFromSignature(fixedSig(0), { evmAddress: SAMPLE_EVM, account: 0n })
    } catch (err) {
      captured = err
    }
    const errObj = captured as { kind?: string; reason?: string }
    expect(errObj.kind).toBe('NonDeterministicSignerError')
    expect(errObj.reason).toBe('cached-checksum-mismatch')
    // No identity bound: the keyManager stays locked.
    expect(isUnlocked()).toBe(false)
  })

  it('the cached-checksum mismatch is scoped to (evmAddress, account) — a different EVM address enrolls fresh', async () => {
    seedStoredWalletId(expectedWalletId(), SAMPLE_EVM)
    seedStoredChecksum('aaaa bbbb cccc', SAMPLE_EVM)
    const otherEvm = '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`
    const { state } = await enrollFromSignature(fixedSig(0), { evmAddress: otherEvm, account: 0n })
    expect(state.id).toBe(expectedWalletId())
    expect(isUnlocked()).toBe(true)
  })
})

describe('unlockFromRootSecret', () => {
  it('unlocks + derives the identity + writes the binding on a fresh device', async () => {
    const root = deriveRootSecret(fixedSig())
    const state = await unlockFromRootSecret(root, { evmAddress: SAMPLE_EVM, account: 0n })
    expect(state.id).toBe(deriveWalletId(root))
    expect(state.railgunAddress).toBe(h.railgunAddress)
    expect(isUnlocked()).toBe(true)
    expect(readStoredMap('armada.shielded.checksums')[SAMPLE_EVM_LC]?.['0']).toBe(state.checksum)
  })

  it('rejects rootSecret of the wrong length', async () => {
    await expect(unlockFromRootSecret(new Uint8Array(16))).rejects.toThrow()
  })

  it('refuses when the derived identity differs from the device binding, without rebinding (P1-13)', async () => {
    seedStoredChecksum('aaaa bbbb cccc')
    const root = deriveRootSecret(fixedSig())
    await expect(
      unlockFromRootSecret(root, { evmAddress: SAMPLE_EVM, account: 0n }),
    ).rejects.toBeInstanceOf(MismatchedRecoverySecretError)
    expect(readStoredMap('armada.shielded.checksums')[SAMPLE_EVM_LC]?.['0']).toBe('aaaa bbbb cccc')
    expect(isUnlocked()).toBe(false)
  })

  it('unlocks when the pasted secret matches the device binding (re-paste of the same secret)', async () => {
    const first = await unlockFromRootSecret(deriveRootSecret(fixedSig()), { evmAddress: SAMPLE_EVM, account: 0n })
    clearKeyManager()
    const again = await unlockFromRootSecret(deriveRootSecret(fixedSig()), { evmAddress: SAMPLE_EVM, account: 0n })
    expect(again.checksum).toBe(first.checksum)
    expect(again.id).toBe(first.id)
    expect(isUnlocked()).toBe(true)
  })
})

describe('unlockFromBackup', () => {
  it('decrypts the backup blob and unlocks', async () => {
    const root = deriveRootSecret(fixedSig())
    const blob = await encryptBackup({ rootSecret: root, creationBlock: 0 }, 'passphrase-here', { iterations: 1000 })
    const state = await unlockFromBackup(blob, 'passphrase-here')
    expect(state.status).toBe('unlocked')
    expect(state.id).toBe(deriveWalletId(root))
    expect(isUnlocked()).toBe(true)
  })

  it('propagates the authentication error when the passphrase is wrong', async () => {
    const root = deriveRootSecret(fixedSig())
    const blob = await encryptBackup({ rootSecret: root, creationBlock: 0 }, 'right-here', { iterations: 1000 })
    await expect(unlockFromBackup(blob, 'wrong-here')).rejects.toThrow(/authentication failed/)
  })
})

describe('lockWallet', () => {
  it('clears the keyManager (in-memory secrets); does not touch the SDK read storage', async () => {
    await enrollFromSignature(fixedSig())
    expect(isUnlocked()).toBe(true)
    await lockWallet('whatever-id-arg-is-ignored')
    expect(isUnlocked()).toBe(false)
    // Lock releases secrets only — the SDK read instance is torn down separately (useShieldedBalanceSync).
    expect(h.deleteSdkReadStorage).not.toHaveBeenCalled()
  })

  it('is a no-op when no wallet is unlocked', async () => {
    expect(isUnlocked()).toBe(false)
    await lockWallet('whatever')
    expect(isUnlocked()).toBe(false)
  })
})

describe('resetWallet', () => {
  it('wipes the SDK read storage and clears the entire per-(EVM,account) map', async () => {
    await enrollFromSignature(fixedSig(), { evmAddress: SAMPLE_EVM, account: 0n })
    expect(readStoredMap('armada.shielded.walletIds')[SAMPLE_EVM_LC]?.['0']).toBe(expectedWalletId())
    await resetWallet('whatever-id-arg-is-ignored')
    expect(h.deleteSdkReadStorage).toHaveBeenCalledTimes(1)
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
    expect(h.deleteSdkReadStorage).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('armada.shielded.walletIds')).toBeNull()
  })
})
