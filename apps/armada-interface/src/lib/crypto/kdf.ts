// ABOUTME: Key derivation per specs/TX_SIGNING.md — HKDF-SHA-256 from signature bytes to root_secret, then HKDF-Expand subkeys.
// ABOUTME: Also: anti-phish checksum, internal-mnemonic shim (Phase 1 SDK compat), AES-GCM backup encryption with PBKDF2.

import { hkdf } from '@noble/hashes/hkdf'
import { expand as hkdfExpand } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { pbkdf2 } from '@noble/hashes/pbkdf2'
import { gcm } from '@noble/ciphers/aes'
import { entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

// ============================================================================
// Constants (identity-determining — see specs/TX_SIGNING.md §"Enrollment Flow")
// ============================================================================

/**
 * HKDF salt for root_secret derivation. Per spec: protocol-wide constant, versioned.
 * Changing this value forks every user's identity.
 */
const HKDF_SALT_V1 = utf8('armada-v1')
const HKDF_INFO_ROOT = utf8('root')

/** Subkey info strings — versioned for migration paths. */
const HKDF_INFO_SPEND_V1 = utf8('spend:v1')
const HKDF_INFO_VIEW_V1 = utf8('view:v1')

/**
 * Internal-only info string for deriving an encryption key passed to the Railgun SDK in Phase 1.
 * Not part of the spec; replaced in Phase 2 when we drop the internal-mnemonic shim entirely.
 * Documented here so future readers understand this is a Phase 1 compromise.
 */
const HKDF_INFO_SDK_ENCRYPTION_V1 = utf8('phase1-sdk-encryption:v1')

/**
 * Anti-phish checksum domain separator (spec §"Anti-Phish Checksum"):
 *   checksum = first_6_bytes(SHA256(root_secret || "armada-check"))
 */
const CHECKSUM_DOMAIN = utf8('armada-check')

// ============================================================================
// Root + subkey derivation
// ============================================================================

/**
 * HKDF-SHA-256 over the 65-byte signature bytes → 32-byte root_secret.
 * Per spec §"HKDF Semantics":
 *   PRK = HKDF-Extract(salt=utf8("armada-v1"), IKM=signature_bytes)
 *   root_secret = HKDF-Expand(PRK, info=utf8("root"), L=32)
 *
 * IC-3 (opaque byte passthrough): we accept the signature as a raw Uint8Array and never parse
 * (r, s, v) through Number-typed intermediates. Callers must pass `normalizeSignature` output.
 */
export function deriveRootSecret(signatureBytes: Uint8Array): Uint8Array {
  if (signatureBytes.length !== 65) {
    throw new Error(`deriveRootSecret: expected 65-byte normalized signature, got ${signatureBytes.length}`)
  }
  return hkdf(sha256, signatureBytes, HKDF_SALT_V1, HKDF_INFO_ROOT, 32)
}

/**
 * Derive raw spending-key bytes from root_secret via HKDF-Expand only (no Extract).
 * Per spec §"HKDF Semantics": subkey derivation uses Expand-only because root_secret is already
 * a 32-byte pseudorandom key.
 *
 * Note: these are 32-byte HKDF outputs, NOT yet reduced to a Baby Jubjub scalar. The field-element
 * conversion (mod r vs mod l) is pending Andrew's confirmation and lands in Phase 2. In Phase 1
 * these bytes are not handed to Railgun directly — see `deriveInternalMnemonic` for the shim.
 */
export function deriveSpendingKeyBytes(rootSecret: Uint8Array): Uint8Array {
  assertRootSecret(rootSecret)
  return hkdfExpand(sha256, rootSecret, HKDF_INFO_SPEND_V1, 32)
}

export function deriveViewingKeyBytes(rootSecret: Uint8Array): Uint8Array {
  assertRootSecret(rootSecret)
  return hkdfExpand(sha256, rootSecret, HKDF_INFO_VIEW_V1, 32)
}

/**
 * Derive a 32-byte encryption key (hex) for the Railgun SDK's at-rest wallet encryption.
 * Returns 64 lowercase hex characters (no `0x` prefix) — matches the SDK's expected format.
 *
 * Phase 1 only: in Phase 2 this disappears because we won't go through the high-level wallet SDK.
 */
export function deriveSdkEncryptionKeyHex(rootSecret: Uint8Array): string {
  assertRootSecret(rootSecret)
  const bytes = hkdfExpand(sha256, rootSecret, HKDF_INFO_SDK_ENCRYPTION_V1, 32)
  return bytesToHexNoPrefix(bytes)
}

/**
 * Convert the 32-byte root_secret into a 24-word BIP-39 mnemonic for SDK consumption only.
 *
 * Phase 1 compromise: the Railgun wallet SDK's public entry point is mnemonic-based. We derive
 * a deterministic mnemonic from root_secret and feed it to `createRailgunWallet`. The mnemonic
 * is NEVER displayed, NEVER exported, NEVER returned to UI code. Callers are expected to zeroize
 * the returned string by going out of scope quickly — JS strings are immutable so explicit
 * zeroization isn't possible, but limiting the lifetime helps. Phase 2 removes this entirely.
 *
 * 24 words = 256 bits, matching root_secret's full entropy (vs the legacy 12-word/128-bit form).
 */
export function deriveInternalMnemonic(rootSecret: Uint8Array): string {
  assertRootSecret(rootSecret)
  // BIP-39 with 32 bytes of entropy = 24 words. @scure/bip39 handles the checksum.
  return entropyToMnemonic(rootSecret, wordlist)
}

// ============================================================================
// Anti-phish checksum
// ============================================================================

/**
 * Compute the 6-byte anti-phish checksum (spec §"Anti-Phish Checksum"):
 *   checksum = first_6_bytes(SHA256(root_secret || "armada-check"))
 *
 * Returns the raw 6 bytes; UI code formats via `formatChecksumDisplay`.
 */
export function antiPhishChecksumBytes(rootSecret: Uint8Array): Uint8Array {
  assertRootSecret(rootSecret)
  const buf = new Uint8Array(rootSecret.length + CHECKSUM_DOMAIN.length)
  buf.set(rootSecret, 0)
  buf.set(CHECKSUM_DOMAIN, rootSecret.length)
  return sha256(buf).slice(0, 6)
}

/**
 * Format the 6-byte checksum as 12 hex characters in three space-separated 4-char groups,
 * matching spec §"Anti-Phish Checksum → Display format options" (e.g. "a3f2 91c8 b7e0").
 */
export function formatChecksumDisplay(checksum: Uint8Array): string {
  if (checksum.length !== 6) {
    throw new Error(`formatChecksumDisplay: expected 6 bytes, got ${checksum.length}`)
  }
  const hex = bytesToHexNoPrefix(checksum)
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)}`
}

// ============================================================================
// IC-1 / IC-2 helpers
// ============================================================================

/**
 * Interpret a byte array as an unsigned BIG-ENDIAN integer, returning a BigInt.
 * Per spec §"Bytes to Field Element Mapping": "Big-endian. Not little-endian, not platform-native.
 * The first byte of HKDF output is the most significant byte of the integer."
 *
 * IC-1 compliance: uses BigInt-only; never touches JavaScript `Number` on the value itself.
 * Phase 2 will compose this with `% r` / `% l` / `% l_ed` per Andrew's modulus confirmation.
 */
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let n = 0n
  for (const b of bytes) {
    n = (n << 8n) | BigInt(b)
  }
  return n
}

/**
 * Assert a derived 32-byte key has at least 2^64 effective entropy (i.e. is not the
 * float-truncation bug Privacy Pools shipped in February 2025). Per spec IC-2 this is a
 * diagnostic canary, not a proof of correctness — IC-4 test vectors do the actual heavy lifting.
 *
 * Applies to root_secret, spending_key bytes, and viewing_key bytes BEFORE any field reduction.
 */
export function assertEntropyFloor(name: string, key: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error(`assertEntropyFloor(${name}): expected 32 bytes, got ${key.length}`)
  }
  if (bytesToBigIntBE(key) < 1n << 64n) {
    throw new Error(
      `${name} entropy below safety floor (< 2^64) — possible truncation bug. ` +
        `This should never happen with a valid signature; aborting derivation.`,
    )
  }
}

// ============================================================================
// Backup encryption (AES-256-GCM + PBKDF2-SHA-256 @ 600k for Phase 1)
// ============================================================================

/**
 * Backup blob format — exactly matches specs/TX_SIGNING.md §"Backup file format" `armada-backup-v1`.
 *
 * Phase 1 uses PBKDF2-SHA-256 @ 600k. Phase 2 will add Argon2id as the preferred KDF (parsers
 * must accept all three — argon2id / scrypt / pbkdf2 — per the interop contract).
 */
/**
 * v2 backup envelope. The plaintext payload is 40 bytes: [0..32) rootSecret, [32..40) uint64-BE
 * creationBlock. `creationBlock` is the hub-chain block at which the wallet was first enrolled —
 * passed to the Railgun SDK's `creationBlockNumbers` on restore so the merkletree scan starts at
 * the right tree position. A value of 0 means "unknown" (e.g. a backup exported after a
 * paste-secret restore where the true creation block was never persisted); the restore path
 * treats 0 as `undefined` and falls back to a full chain rescan (correct, slow).
 *
 * v1 → v2 was a breaking change driven by a silent-balance-loss bug: v1 backups had no
 * creationBlock, so a restore-from-backup re-ran `getCurrentHubBlock()` and used the result as
 * the SDK's scan start position — silently skipping all of the user's prior on-chain commitments.
 * No v1 → v2 migrator is provided per the project's "testnet wallets are disposable" policy.
 */
export interface BackupBlob {
  /**
   * Backup envelope version.
   *
   * - `armada-backup-v2`: current — 40-byte plaintext payload with embedded creationBlock.
   *   `encryptBackup` always emits v2.
   * - `armada-backup-v1`: legacy read-only — 32-byte plaintext (rootSecret only). Decrypts
   *   with synthesized `creationBlock = 0`, which the unlock path treats as "unknown" →
   *   full chain rescan. Kept so users with pre-existing v1 backups can restore + run a
   *   slow scan rather than being forced to re-enroll.
   */
  readonly format: 'armada-backup-v1' | 'armada-backup-v2'
  readonly kdf: 'pbkdf2-sha256'
  readonly kdf_params: { readonly iterations: number }
  /** 32-byte salt, hex-encoded, no 0x prefix. */
  readonly kdf_salt: string
  readonly cipher: 'aes-256-gcm'
  /** 12-byte AES-GCM nonce, hex-encoded, no 0x prefix. */
  readonly nonce: string
  /** Ciphertext, hex-encoded, no 0x prefix. Length matches plaintext (40 bytes for v2; 32 bytes for v1). */
  readonly ciphertext: string
  /** 16-byte AES-GCM authentication tag, hex-encoded, no 0x prefix. */
  readonly tag: string
}

/** Plaintext shape carried inside the encrypted blob. */
export interface BackupPayload {
  readonly rootSecret: Uint8Array
  /** Hub block at wallet creation; 0 = unknown. See BackupBlob doc for the contract. */
  readonly creationBlock: number
}

export const PBKDF2_ITERATIONS_V1 = 600_000
const PAYLOAD_BYTES = 40 // 32 rootSecret + 8 creationBlock(uint64 BE)

export interface EncryptOptions {
  /**
   * Override the PBKDF2 iteration count. Production code must NOT pass this — leave it undefined
   * to inherit the spec-mandated 600k. Test code passes a small value (e.g. 1000) to keep PBKDF2
   * from dominating the suite runtime; the encryption shape is identical. Decryption always
   * honors whatever count is in the blob, so a small-iteration test blob is fully round-trippable.
   */
  readonly iterations?: number
}

function encodePayload(payload: BackupPayload): Uint8Array {
  assertRootSecret(payload.rootSecret)
  if (!Number.isInteger(payload.creationBlock) || payload.creationBlock < 0) {
    throw new Error('encryptBackup: creationBlock must be a non-negative integer (or 0 for unknown)')
  }
  // uint64 max is enough for any chain head we'll ever see. Number is safe up to 2^53; refuse
  // anything beyond that rather than silently truncating.
  if (payload.creationBlock > Number.MAX_SAFE_INTEGER) {
    throw new Error('encryptBackup: creationBlock exceeds Number.MAX_SAFE_INTEGER')
  }
  const out = new Uint8Array(PAYLOAD_BYTES)
  out.set(payload.rootSecret, 0)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setBigUint64(32, BigInt(payload.creationBlock), false /* big-endian */)
  return out
}

function decodePayload(plain: Uint8Array): BackupPayload {
  if (plain.length !== PAYLOAD_BYTES) {
    throw new Error(`decryptBackup: expected ${PAYLOAD_BYTES}-byte payload, got ${plain.length}`)
  }
  const rootSecret = plain.slice(0, 32)
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  const creationBlockBig = view.getBigUint64(32, false /* big-endian */)
  if (creationBlockBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('decryptBackup: creationBlock exceeds Number.MAX_SAFE_INTEGER')
  }
  return { rootSecret, creationBlock: Number(creationBlockBig) }
}

/**
 * Encrypt a backup payload with a user-chosen passphrase. Returns a v2 blob suitable for
 * serializing to JSON and saving to disk.
 */
export function encryptBackup(
  payload: BackupPayload,
  passphrase: string,
  options?: EncryptOptions,
): BackupBlob {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('encryptBackup: passphrase must be at least 8 characters')
  }
  const iterations = options?.iterations ?? PBKDF2_ITERATIONS_V1
  if (iterations < 1) {
    throw new Error('encryptBackup: iterations must be >= 1')
  }
  const salt = randomBytes(32)
  const nonce = randomBytes(12)
  const key = deriveBackupKey(passphrase, salt, iterations)
  const plain = encodePayload(payload)
  const cipher = gcm(key, nonce)
  // @noble/ciphers gcm: tag is appended to the ciphertext; we split it for spec compliance.
  const combined = cipher.encrypt(plain)
  const ciphertext = combined.slice(0, plain.length)
  const tag = combined.slice(plain.length)
  return {
    format: 'armada-backup-v2',
    kdf: 'pbkdf2-sha256',
    kdf_params: { iterations },
    kdf_salt: bytesToHexNoPrefix(salt),
    nonce: bytesToHexNoPrefix(nonce),
    cipher: 'aes-256-gcm',
    ciphertext: bytesToHexNoPrefix(ciphertext),
    tag: bytesToHexNoPrefix(tag),
  }
}

/**
 * Decrypt a backup blob with the matching passphrase. Throws on tag mismatch (wrong
 * passphrase or corrupted blob).
 *
 * v2 path returns the embedded creationBlock as-is. v1 path (legacy 32-byte plaintext) returns
 * `creationBlock: 0` — the unlock path's `creationBlock === 0` sentinel converts that to
 * `undefined` when calling into the SDK, producing a slow full-genesis rescan. This preserves
 * existing v1 backups as a "correct but slow" restore path rather than rejecting outright.
 */
export function decryptBackup(blob: BackupBlob, passphrase: string): BackupPayload {
  if (blob.format !== 'armada-backup-v1' && blob.format !== 'armada-backup-v2') {
    throw new Error(`decryptBackup: unsupported format "${blob.format}"`)
  }
  if (blob.kdf !== 'pbkdf2-sha256') {
    throw new Error(`decryptBackup: unsupported kdf "${blob.kdf}" (Phase 1 only supports pbkdf2-sha256)`)
  }
  if (blob.cipher !== 'aes-256-gcm') {
    throw new Error(`decryptBackup: unsupported cipher "${blob.cipher}"`)
  }
  const salt = hexToBytesNoPrefix(blob.kdf_salt)
  const nonce = hexToBytesNoPrefix(blob.nonce)
  const ciphertext = hexToBytesNoPrefix(blob.ciphertext)
  const tag = hexToBytesNoPrefix(blob.tag)
  if (tag.length !== 16) throw new Error('decryptBackup: tag must be 16 bytes')
  if (nonce.length !== 12) throw new Error('decryptBackup: nonce must be 12 bytes')

  const key = deriveBackupKey(passphrase, salt, blob.kdf_params.iterations)
  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext, 0)
  combined.set(tag, ciphertext.length)
  const cipher = gcm(key, nonce)
  let plain: Uint8Array
  try {
    plain = cipher.decrypt(combined)
  } catch {
    throw new Error('decryptBackup: authentication failed (wrong passphrase or corrupted backup)')
  }
  if (blob.format === 'armada-backup-v1') {
    // Legacy 32-byte payload: rootSecret only. Synthesize creationBlock = 0 so the unlock
    // path treats it as "unknown" and falls back to a slow full chain rescan — correct, just
    // slow. The user can re-export to v2 from the unlocked session to make future restores fast.
    if (plain.length !== 32) {
      throw new Error(`decryptBackup: v1 expected 32-byte payload, got ${plain.length}`)
    }
    return { rootSecret: plain, creationBlock: 0 }
  }
  return decodePayload(plain)
}

const BACKUP_JSON_INVALID_MSG =
  'Backup file is not valid JSON. The file may be corrupted, incomplete, or not an Armada export. ' +
  'Open it in a text editor — it should be one object with `"format": "armada-backup-v2"`. ' +
  'Export a fresh file from Settings → Export recovery secret while your wallet is unlocked.'

/**
 * Parse backup file text (from disk upload). Strips BOM, validates JSON, then `parseBackupBlob`.
 */
export function parseBackupJsonText(text: string): BackupBlob {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) {
    throw new Error('Backup file is empty.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error(BACKUP_JSON_INVALID_MSG)
  }
  return parseBackupBlob(parsed)
}

/** Map low-level parse / storage errors to user-facing unlock messages. */
export function normalizeBackupUnlockError(err: unknown): Error {
  if (err instanceof Error) {
    if (err instanceof SyntaxError || /Unexpected token/i.test(err.message)) {
      return new Error(BACKUP_JSON_INVALID_MSG)
    }
    return err
  }
  return new Error('Unlock failed.')
}

/**
 * Parse + validate an unknown JSON object as a BackupBlob. Rejects unknown top-level fields per
 * spec interop contract.
 */
export function parseBackupBlob(json: unknown): BackupBlob {
  if (Array.isArray(json)) {
    if (
      json.length === 1 &&
      typeof json[0] === 'object' &&
      json[0] !== null &&
      !Array.isArray(json[0])
    ) {
      return parseBackupBlob(json[0])
    }
    throw new Error('parseBackupBlob: expected one backup object, not a JSON array')
  }
  if (typeof json === 'string') {
    return parseBackupJsonText(json)
  }
  if (typeof json !== 'object' || json === null) {
    throw new Error('parseBackupBlob: input is not an object')
  }
  const o = json as Record<string, unknown>
  const allowed = new Set(['format', 'kdf', 'kdf_params', 'kdf_salt', 'cipher', 'nonce', 'ciphertext', 'tag'])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) {
      throw new Error(`parseBackupBlob: unknown top-level field "${k}"`)
    }
  }
  // v1 backups are accepted as a legacy read-only path. decryptBackup handles them by
  // synthesizing creationBlock = 0 (treated as "unknown" → full chain rescan). See BackupBlob
  // doc for the contract; encryption always writes v2.
  if (o.format !== 'armada-backup-v1' && o.format !== 'armada-backup-v2') {
    throw new Error(`parseBackupBlob: unsupported format "${String(o.format)}"`)
  }
  const format = o.format as 'armada-backup-v1' | 'armada-backup-v2'
  if (o.kdf !== 'pbkdf2-sha256' && o.kdf !== 'argon2id' && o.kdf !== 'scrypt') {
    throw new Error(`parseBackupBlob: unsupported kdf "${String(o.kdf)}"`)
  }
  if (o.cipher !== 'aes-256-gcm') {
    throw new Error(`parseBackupBlob: unsupported cipher "${String(o.cipher)}"`)
  }
  if (typeof o.kdf_salt !== 'string' || typeof o.nonce !== 'string' || typeof o.ciphertext !== 'string' || typeof o.tag !== 'string') {
    throw new Error('parseBackupBlob: hex fields must be strings')
  }
  const kdf_params = o.kdf_params
  if (typeof kdf_params !== 'object' || kdf_params === null) {
    throw new Error('parseBackupBlob: kdf_params missing or invalid')
  }
  const iterations = (kdf_params as Record<string, unknown>).iterations
  if (o.kdf === 'pbkdf2-sha256' && (typeof iterations !== 'number' || iterations < 1)) {
    throw new Error('parseBackupBlob: pbkdf2 iterations missing or invalid')
  }
  // We only construct the strict Phase 1 shape; argon2id/scrypt parsing lands in Phase 2.
  if (o.kdf !== 'pbkdf2-sha256') {
    throw new Error(`parseBackupBlob: Phase 1 SDK cannot decrypt ${o.kdf} backups`)
  }
  return {
    format,
    kdf: 'pbkdf2-sha256',
    kdf_params: { iterations: iterations as number },
    kdf_salt: o.kdf_salt,
    nonce: o.nonce,
    cipher: 'aes-256-gcm',
    ciphertext: o.ciphertext,
    tag: o.tag,
  }
}

function deriveBackupKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS_V1): Uint8Array {
  return pbkdf2(sha256, utf8(passphrase), salt, { c: iterations, dkLen: 32 })
}

// ============================================================================
// Internal helpers
// ============================================================================

function assertRootSecret(rootSecret: Uint8Array): void {
  if (rootSecret.length !== 32) {
    throw new Error(`expected 32-byte root_secret, got ${rootSecret.length}`)
  }
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

/** Lowercase hex string, no 0x prefix. */
function bytesToHexNoPrefix(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) {
    s += b.toString(16).padStart(2, '0')
  }
  return s
}

function hexToBytesNoPrefix(hex: string): Uint8Array {
  const s = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (s.length % 2 !== 0) throw new Error('hex string must have even length')
  if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error('invalid hex characters')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    const hi = hexNibble(s.charCodeAt(i * 2))
    const lo = hexNibble(s.charCodeAt(i * 2 + 1))
    out[i] = (hi << 4) | lo
  }
  return out
}

function hexNibble(charCode: number): number {
  // IC-1: this never touches signature/key material directly — it's pure hex decoding for
  // backup-blob hex fields. Used here instead of parseInt() to keep lint guards clean.
  if (charCode >= 48 && charCode <= 57) return charCode - 48 // '0'-'9'
  if (charCode >= 97 && charCode <= 102) return charCode - 87 // 'a'-'f'
  if (charCode >= 65 && charCode <= 70) return charCode - 55 // 'A'-'F'
  throw new Error('invalid hex character')
}
