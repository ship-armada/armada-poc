// ABOUTME: Tests for lib/crypto/kdf — HKDF derivation determinism, anti-phish checksum, internal mnemonic shim, AES-GCM backup round-trip, IC-2 canary.

import { describe, it, expect } from 'vitest'
import {
  deriveRootSecret,
  deriveSpendingKeyBytes,
  deriveViewingKeyBytes,
  deriveSdkEncryptionKeyHex,
  deriveInternalMnemonic,
  antiPhishChecksumBytes,
  formatChecksumDisplay,
  assertEntropyFloor,
  encryptBackup,
  decryptBackup,
  parseBackupBlob,
  parseBackupJsonText,
  PBKDF2_ITERATIONS_V1,
  type BackupBlob,
  type EncryptOptions,
} from './kdf'

/**
 * Test-only iteration override. Production code MUST NOT pass options.iterations — the absence
 * inherits the spec-mandated PBKDF2_ITERATIONS_V1 (600k). Test code uses 1000 to keep PBKDF2
 * from dominating the suite runtime. The encryption shape is bit-identical regardless.
 */
const TEST_OPTS: EncryptOptions = { iterations: 1000 }
import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

/** Deterministic 65-byte signature fixture. */
function fixedSignature(seed: number = 0): Uint8Array {
  const out = new Uint8Array(65)
  for (let i = 0; i < 64; i++) out[i] = (seed + i) & 0xff
  out[64] = 27
  return out
}

describe('deriveRootSecret', () => {
  it('returns 32 bytes', () => {
    expect(deriveRootSecret(fixedSignature()).length).toBe(32)
  })

  it('is deterministic for the same signature', () => {
    expect(deriveRootSecret(fixedSignature(0))).toEqual(deriveRootSecret(fixedSignature(0)))
  })

  it('produces different output for different signatures', () => {
    const a = deriveRootSecret(fixedSignature(0))
    const b = deriveRootSecret(fixedSignature(1))
    expect(a).not.toEqual(b)
  })

  it('rejects non-65-byte input', () => {
    expect(() => deriveRootSecret(new Uint8Array(64))).toThrow()
    expect(() => deriveRootSecret(new Uint8Array(66))).toThrow()
  })
})

describe('subkey derivation', () => {
  it('spending and viewing keys are distinct (different info strings)', () => {
    const root = deriveRootSecret(fixedSignature())
    const spend = deriveSpendingKeyBytes(root)
    const view = deriveViewingKeyBytes(root)
    expect(spend).not.toEqual(view)
    expect(spend.length).toBe(32)
    expect(view.length).toBe(32)
  })

  it('subkey derivation is deterministic and pure', () => {
    const root = deriveRootSecret(fixedSignature())
    expect(deriveSpendingKeyBytes(root)).toEqual(deriveSpendingKeyBytes(root))
    expect(deriveViewingKeyBytes(root)).toEqual(deriveViewingKeyBytes(root))
  })

  it('rejects non-32-byte root', () => {
    expect(() => deriveSpendingKeyBytes(new Uint8Array(16))).toThrow()
    expect(() => deriveViewingKeyBytes(new Uint8Array(64))).toThrow()
  })
})

describe('deriveSdkEncryptionKeyHex', () => {
  it('returns 64 lowercase hex chars (no 0x prefix) — SDK-expected format', () => {
    const root = deriveRootSecret(fixedSignature())
    const key = deriveSdkEncryptionKeyHex(root)
    expect(key.length).toBe(64)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic and distinct from spend/view key bytes', () => {
    const root = deriveRootSecret(fixedSignature())
    const enc = deriveSdkEncryptionKeyHex(root)
    expect(enc).toBe(deriveSdkEncryptionKeyHex(root))
    const spend = deriveSpendingKeyBytes(root)
    const spendHex = Array.from(spend, b => b.toString(16).padStart(2, '0')).join('')
    expect(enc).not.toBe(spendHex)
  })
})

describe('deriveInternalMnemonic', () => {
  it('returns a 24-word BIP-39 mnemonic', () => {
    const root = deriveRootSecret(fixedSignature())
    const m = deriveInternalMnemonic(root)
    const words = m.split(' ')
    expect(words.length).toBe(24)
    expect(validateMnemonic(m, wordlist)).toBe(true)
  })

  it('is deterministic from root_secret', () => {
    const root = deriveRootSecret(fixedSignature())
    expect(deriveInternalMnemonic(root)).toBe(deriveInternalMnemonic(root))
  })

  it('two different root_secrets produce two different mnemonics', () => {
    const a = deriveInternalMnemonic(deriveRootSecret(fixedSignature(0)))
    const b = deriveInternalMnemonic(deriveRootSecret(fixedSignature(1)))
    expect(a).not.toBe(b)
  })
})

describe('antiPhishChecksum', () => {
  it('returns exactly 6 bytes', () => {
    const root = deriveRootSecret(fixedSignature())
    expect(antiPhishChecksumBytes(root).length).toBe(6)
  })

  it('is deterministic for the same root', () => {
    const root = deriveRootSecret(fixedSignature())
    expect(antiPhishChecksumBytes(root)).toEqual(antiPhishChecksumBytes(root))
  })

  it('differs for different roots', () => {
    const a = antiPhishChecksumBytes(deriveRootSecret(fixedSignature(0)))
    const b = antiPhishChecksumBytes(deriveRootSecret(fixedSignature(1)))
    expect(a).not.toEqual(b)
  })

  it('formats display as three space-separated 4-char groups', () => {
    const cs = new Uint8Array([0xa3, 0xf2, 0x91, 0xc8, 0xb7, 0xe0])
    expect(formatChecksumDisplay(cs)).toBe('a3f2 91c8 b7e0')
  })

  it('rejects checksums of the wrong length', () => {
    expect(() => formatChecksumDisplay(new Uint8Array(5))).toThrow()
    expect(() => formatChecksumDisplay(new Uint8Array(7))).toThrow()
  })
})

describe('assertEntropyFloor (IC-2)', () => {
  it('passes a normal 32-byte key', () => {
    const root = deriveRootSecret(fixedSignature())
    expect(() => assertEntropyFloor('root', root)).not.toThrow()
  })

  it('throws when the high 192 bits are zero (i.e. value < 2^64)', () => {
    const tiny = new Uint8Array(32)
    tiny[31] = 0xff // value = 255
    expect(() => assertEntropyFloor('test', tiny)).toThrow(/below safety floor/)
  })

  it('passes when the value is exactly 2^64', () => {
    const buf = new Uint8Array(32)
    buf[23] = 1 // 1 << 64 in big-endian
    expect(() => assertEntropyFloor('test', buf)).not.toThrow()
  })

  it('throws on wrong size', () => {
    expect(() => assertEntropyFloor('test', new Uint8Array(16))).toThrow()
  })
})

// PBKDF2 @ 600k iterations is intentionally slow — that's the security property. jsdom is
// slower than real V8, so these tests routinely hit the default 5s timeout. Bump per-describe;
// in production each backup encrypt/decrypt runs once per user action.
describe('backup encryption round-trip (v2)', { timeout: 30_000 }, () => {
  it('encrypts and decrypts a payload (rootSecret + creationBlock) with the same passphrase', () => {
    const rootSecret = deriveRootSecret(fixedSignature())
    const creationBlock = 12_345_678
    const blob = encryptBackup({ rootSecret, creationBlock }, 'correct-horse', TEST_OPTS)
    const recovered = decryptBackup(blob, 'correct-horse')
    expect(recovered.rootSecret).toEqual(rootSecret)
    expect(recovered.creationBlock).toBe(creationBlock)
  })

  it('round-trips a creationBlock of 0 (the "unknown" sentinel for paste-restored exports)', () => {
    // WHY: paste-secret restores have no creationBlock available; exportBackup writes 0 in
    // that case to signal "scan from genesis" on the next restore. The encoder must accept 0
    // and the decoder must round-trip it bit-exactly so the unlockFromBackup path can detect
    // the sentinel and pass `undefined` to the SDK.
    const rootSecret = deriveRootSecret(fixedSignature())
    const blob = encryptBackup({ rootSecret, creationBlock: 0 }, 'right-passphrase', TEST_OPTS)
    const recovered = decryptBackup(blob, 'right-passphrase')
    expect(recovered.creationBlock).toBe(0)
  })

  it('round-trips a large creationBlock near Number.MAX_SAFE_INTEGER', () => {
    // WHY: pin the 8-byte uint64-BE encoding. A naive 32-bit encoding would silently truncate
    // any block past 2^32, leaving the restore path with a wrong scan-start position. Sepolia
    // is well under 2^32 today but future-proofing is cheap.
    const rootSecret = deriveRootSecret(fixedSignature())
    const creationBlock = Number.MAX_SAFE_INTEGER - 1
    const blob = encryptBackup({ rootSecret, creationBlock }, 'right-passphrase', TEST_OPTS)
    const recovered = decryptBackup(blob, 'right-passphrase')
    expect(recovered.creationBlock).toBe(creationBlock)
  })

  it('rejects negative or non-integer creationBlock at encrypt', () => {
    // WHY: BigInt uint64 has no signed slot, and fractional blocks make no sense. Loud failure
    // at encrypt-time means a bug elsewhere (e.g. accidental Date.now() in a creationBlock
    // slot) doesn't silently land in a backup that then fails to restore correctly.
    const rootSecret = deriveRootSecret(fixedSignature())
    expect(() => encryptBackup({ rootSecret, creationBlock: -1 }, 'pw-here-now', TEST_OPTS)).toThrow(/non-negative integer/)
    expect(() => encryptBackup({ rootSecret, creationBlock: 1.5 }, 'pw-here-now', TEST_OPTS)).toThrow(/non-negative integer/)
  })

  it('produces the v2 spec backup format shape', () => {
    const rootSecret = deriveRootSecret(fixedSignature())
    const blob = encryptBackup({ rootSecret, creationBlock: 100 }, 'passphrase-here', TEST_OPTS)
    expect(blob.format).toBe('armada-backup-v2')
    expect(blob.kdf).toBe('pbkdf2-sha256')
    expect(blob.kdf_params.iterations).toBeGreaterThanOrEqual(1) // test uses TEST_OPTS = 1000
    expect(blob.cipher).toBe('aes-256-gcm')
    expect(blob.kdf_salt).toMatch(/^[0-9a-f]{64}$/) // 32 bytes
    expect(blob.nonce).toMatch(/^[0-9a-f]{24}$/) // 12 bytes
    // v2 plaintext is 40 bytes (32 rootSecret + 8 creationBlock BE), so ciphertext = 40 bytes = 80 hex chars.
    expect(blob.ciphertext).toMatch(/^[0-9a-f]{80}$/)
    expect(blob.tag).toMatch(/^[0-9a-f]{32}$/) // 16 bytes
  })

  it('defaults to PBKDF2_ITERATIONS_V1 (600k) when options is omitted — spec-mandated', () => {
    // Slow test by design: this is the only spot we exercise the production iteration count.
    const rootSecret = deriveRootSecret(fixedSignature())
    const blob = encryptBackup({ rootSecret, creationBlock: 0 }, 'production-defaults')
    expect(blob.kdf_params.iterations).toBe(PBKDF2_ITERATIONS_V1)
    expect(PBKDF2_ITERATIONS_V1).toBe(600_000)
  })

  it('fails decryption with the wrong passphrase', () => {
    const rootSecret = deriveRootSecret(fixedSignature())
    const blob = encryptBackup({ rootSecret, creationBlock: 42 }, 'right-passphrase', TEST_OPTS)
    expect(() => decryptBackup(blob, 'wrong-passphrase')).toThrow(/authentication failed/)
  })

  it('produces different ciphertexts for repeated encryptions (random salt + nonce)', () => {
    const rootSecret = deriveRootSecret(fixedSignature())
    const a = encryptBackup({ rootSecret, creationBlock: 0 }, 'pw-here-now', TEST_OPTS)
    const b = encryptBackup({ rootSecret, creationBlock: 0 }, 'pw-here-now', TEST_OPTS)
    expect(a.kdf_salt).not.toBe(b.kdf_salt)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    // But both decrypt to the same payload
    expect(decryptBackup(a, 'pw-here-now').rootSecret).toEqual(rootSecret)
    expect(decryptBackup(b, 'pw-here-now').rootSecret).toEqual(rootSecret)
  })

  it('rejects short passphrases on encrypt', () => {
    const rootSecret = deriveRootSecret(fixedSignature())
    expect(() => encryptBackup({ rootSecret, creationBlock: 0 }, 'short')).toThrow(/at least 8/)
  })

  it('rejects a tampered ciphertext (AES-GCM auth tag)', () => {
    const rootSecret = deriveRootSecret(fixedSignature())
    const blob = encryptBackup({ rootSecret, creationBlock: 7 }, 'right-here', TEST_OPTS)
    // Flip a bit in the ciphertext
    const tampered: BackupBlob = { ...blob, ciphertext: '00' + blob.ciphertext.slice(2) }
    expect(() => decryptBackup(tampered, 'right-here')).toThrow(/authentication failed/)
  })

  it('rejects a tampered auth tag', () => {
    const rootSecret = deriveRootSecret(fixedSignature())
    const blob = encryptBackup({ rootSecret, creationBlock: 7 }, 'right-here', TEST_OPTS)
    const tampered: BackupBlob = { ...blob, tag: '00' + blob.tag.slice(2) }
    expect(() => decryptBackup(tampered, 'right-here')).toThrow(/authentication failed/)
  })

  it('decrypts a v1 backup with synthesized creationBlock = 0', async () => {
    // WHY: legacy read-only path for users with pre-existing v1 backups (no embedded
    // creationBlock). The decrypt returns creationBlock = 0; the unlock layer converts that
    // sentinel to `undefined` so the SDK runs a full chain rescan — correct, slow. Without
    // this path, v1 users would be forced to re-enroll. We construct a v1 blob by hand by
    // encrypting only the 32-byte rootSecret through @noble/ciphers gcm.
    const { gcm } = await import('@noble/ciphers/aes')
    const rootSecret = deriveRootSecret(fixedSignature())
    const passphrase = 'right-here-now'
    const salt = new Uint8Array(32).fill(7)
    const nonce = new Uint8Array(12).fill(11)
    // Mirror the same KDF the production encryptBackup uses so the round-trip works.
    const { pbkdf2 } = await import('@noble/hashes/pbkdf2')
    const { sha256 } = await import('@noble/hashes/sha2')
    const key = pbkdf2(sha256, new TextEncoder().encode(passphrase), salt, { c: 1000, dkLen: 32 })
    const cipher = gcm(key, nonce)
    const combined = cipher.encrypt(rootSecret) // 32 bytes ciphertext + 16 bytes tag
    const v1Blob: BackupBlob = {
      format: 'armada-backup-v1',
      kdf: 'pbkdf2-sha256',
      kdf_params: { iterations: 1000 },
      kdf_salt: Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join(''),
      nonce: Array.from(nonce).map((b) => b.toString(16).padStart(2, '0')).join(''),
      cipher: 'aes-256-gcm',
      ciphertext: Array.from(combined.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join(''),
      tag: Array.from(combined.slice(32)).map((b) => b.toString(16).padStart(2, '0')).join(''),
    }
    const payload = decryptBackup(v1Blob, passphrase)
    expect(payload.rootSecret).toEqual(rootSecret)
    expect(payload.creationBlock).toBe(0)
  })

  it('rejects a v1 blob whose decrypted payload is not 32 bytes', () => {
    // WHY: belt-and-suspenders length check — a corrupted v1 blob that decrypts to a longer
    // payload would otherwise be mistakenly accepted with a truncated rootSecret. Loud failure
    // makes the corruption obvious.
    const rootSecret = deriveRootSecret(fixedSignature())
    // Encrypt as v2 (40 bytes) but flag it as v1 — synthetic corruption.
    const v2 = encryptBackup({ rootSecret, creationBlock: 0 }, 'right-here', TEST_OPTS)
    const mislabeled: BackupBlob = { ...v2, format: 'armada-backup-v1' }
    expect(() => decryptBackup(mislabeled, 'right-here')).toThrow(/v1 expected 32-byte payload/)
  })
})

describe('parseBackupJsonText', () => {
  it('rejects malformed JSON with a friendly message', () => {
    expect(() => parseBackupJsonText('{ "format": ]')).toThrow(/not valid JSON/i)
  })

  it('rejects empty files', () => {
    expect(() => parseBackupJsonText('   ')).toThrow(/empty/i)
  })

  it('unwraps a one-element JSON array (common duplicate-download shape)', () => {
    const rootSecret = deriveRootSecret(fixedSignature())
    const blob = encryptBackup({ rootSecret, creationBlock: 42 }, 'pw-here-now', TEST_OPTS)
    const wrapped = JSON.stringify([JSON.parse(JSON.stringify(blob))])
    const parsed = parseBackupJsonText(wrapped)
    expect(parsed.format).toBe('armada-backup-v2')
  })
})

describe('parseBackupBlob', { timeout: 30_000 }, () => {
  it('parses a valid pbkdf2 v2 blob', () => {
    const rootSecret = deriveRootSecret(fixedSignature())
    const blob = encryptBackup({ rootSecret, creationBlock: 100 }, 'right-here', TEST_OPTS)
    const json = JSON.parse(JSON.stringify(blob))
    const parsed = parseBackupBlob(json)
    expect(parsed).toEqual(blob)
  })

  it('rejects unknown top-level fields (per spec interop contract)', () => {
    const blob = encryptBackup({ rootSecret: deriveRootSecret(fixedSignature()), creationBlock: 0 }, 'pw-here-now', TEST_OPTS)
    const extended = { ...blob, extra: 'field' }
    expect(() => parseBackupBlob(extended)).toThrow(/unknown top-level field/)
  })

  it('rejects unknown formats', () => {
    expect(() => parseBackupBlob({ format: 'armada-backup-v3' })).toThrow(/unsupported format/)
  })

  it('accepts a v1 backup as legacy read-only (no creationBlock)', () => {
    // WHY: v1 backups predate the embedded creationBlock. We accept them to let users with
    // pre-existing v1 backups still restore — the decryptBackup path synthesizes
    // creationBlock = 0, which unlockFromBackup converts to `undefined`, which the SDK
    // resolves as "scan from chain genesis" (correct, slow). Without this acceptance, v1
    // users would be forced to re-enroll. The v1 → v2 promotion happens naturally the next
    // time they exportBackup from the unlocked session.
    const v1Shaped = {
      format: 'armada-backup-v1',
      kdf: 'pbkdf2-sha256',
      kdf_params: { iterations: 1000 },
      kdf_salt: 'aa'.repeat(32),
      nonce: 'bb'.repeat(12),
      cipher: 'aes-256-gcm',
      ciphertext: 'cc'.repeat(32), // v1 is 32 bytes (rootSecret only)
      tag: 'dd'.repeat(16),
    }
    const parsed = parseBackupBlob(v1Shaped)
    expect(parsed.format).toBe('armada-backup-v1')
  })

  it('rejects argon2id blobs in Phase 1 (forward-compatible)', () => {
    expect(() =>
      parseBackupBlob({
        format: 'armada-backup-v2',
        kdf: 'argon2id',
        kdf_params: { t: 3, m: 65536, p: 4 },
        kdf_salt: '00'.repeat(32),
        nonce: '00'.repeat(12),
        cipher: 'aes-256-gcm',
        ciphertext: '00'.repeat(40),
        tag: '00'.repeat(16),
      }),
    ).toThrow(/Phase 1/)
  })
})
