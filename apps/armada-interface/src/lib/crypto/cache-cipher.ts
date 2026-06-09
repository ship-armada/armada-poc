// ABOUTME: At-rest AES-256-GCM cache envelope helpers — wraps any JSON-serializable value under a 32-byte key with a fresh 12-byte nonce per record.
// ABOUTME: BigInt support via a __bigint sentinel in the JSON. Unwrap throws on auth failure (wrong key OR corrupted blob); storage layer interprets the throw as "skip this record".

import { gcm } from '@noble/ciphers/aes'

/**
 * Envelope shape persisted in IndexedDB (or anywhere else the cache layer puts it). Both fields
 * are lowercase hex, no 0x prefix:
 *
 *   - `nonce`: 12 bytes, random per record. NEVER reuse a (key, nonce) pair across calls;
 *     reuse breaks AES-GCM's confidentiality + authenticity guarantees catastrophically.
 *   - `ciphertext`: variable length. Equal to `plaintext.length + 16` bytes (the GCM tag is
 *     appended by the underlying primitive and not split here).
 *
 * Privacy note: the envelope deliberately carries NO plaintext metadata — no walletId, no kind,
 * no timestamps. A consumer with the wrong key sees an opaque blob and learns nothing about
 * what's inside. Phase 6's filter-on-load uses post-decrypt comparison (records belonging to the
 * active wallet successfully decrypt; foreign records throw and get skipped), so the active
 * walletId never needs to leak to the envelope shape.
 */
export interface EncryptedBlob {
  readonly nonce: string
  readonly ciphertext: string
}

/**
 * BigInt JSON-roundtrip sentinel. TxRecord includes bigint fields (amounts, timestamps via
 * ms-Number-conversions stay as numbers, but `meta.amount` is bigint). Plain JSON.stringify
 * throws on bigint; structured clone (which IndexedDB uses natively) handles it but we're
 * going through JSON because we need a byte buffer to feed AES-GCM.
 *
 * Same trick on the way back via the reviver. The marker is `__bigint` (double underscore
 * prefix) to avoid colliding with any plausible business-domain key name.
 */
const BIGINT_SENTINEL_KEY = '__bigint'

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return { [BIGINT_SENTINEL_KEY]: value.toString() }
  return value
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    BIGINT_SENTINEL_KEY in value &&
    typeof (value as Record<string, unknown>)[BIGINT_SENTINEL_KEY] === 'string'
  ) {
    return BigInt((value as Record<string, string>)[BIGINT_SENTINEL_KEY]!)
  }
  return value
}

function bytesToHexNoPrefix(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

function hexToBytesNoPrefix(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length')
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex characters')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

/**
 * Encrypt `value` (any JSON-serializable shape, plus bigints) with the supplied 32-byte key.
 * Generates a fresh random nonce — callers must NOT pre-supply one, ever.
 */
export function wrap<T>(value: T, key: Uint8Array): EncryptedBlob {
  if (key.length !== 32) {
    throw new Error(`cache-cipher.wrap: key must be 32 bytes, got ${key.length}`)
  }
  const plaintext = new TextEncoder().encode(JSON.stringify(value, jsonReplacer))
  const nonce = randomBytes(12)
  const cipher = gcm(key, nonce)
  const ciphertext = cipher.encrypt(plaintext)
  return {
    nonce: bytesToHexNoPrefix(nonce),
    ciphertext: bytesToHexNoPrefix(ciphertext),
  }
}

/**
 * Decrypt + parse an envelope under the supplied key. Throws on:
 *  - Malformed key length
 *  - Malformed envelope shape (non-hex / wrong nonce length)
 *  - AES-GCM tag verification failure (wrong key OR tampered ciphertext)
 *  - JSON.parse failure on the decrypted bytes
 *
 * Storage layer interprets ANY throw as "this record isn't for this wallet, skip it" — see
 * lib/tx/storage.ts::loadAllTx. That's how we get wallet-isolation on read without leaking
 * a plaintext walletId in the envelope.
 */
export function unwrap<T>(blob: EncryptedBlob, key: Uint8Array): T {
  if (key.length !== 32) {
    throw new Error(`cache-cipher.unwrap: key must be 32 bytes, got ${key.length}`)
  }
  const nonce = hexToBytesNoPrefix(blob.nonce)
  if (nonce.length !== 12) {
    throw new Error(`cache-cipher.unwrap: nonce must be 12 bytes, got ${nonce.length}`)
  }
  const ciphertext = hexToBytesNoPrefix(blob.ciphertext)
  const cipher = gcm(key, nonce)
  const plaintext = cipher.decrypt(ciphertext) // throws on auth failure
  return JSON.parse(new TextDecoder().decode(plaintext), jsonReviver) as T
}

/**
 * Type guard for envelopes returned from `cacheAll<T>`. A consumer reading legacy plaintext
 * records (pre-Phase-7) wants to skip them without trying to unwrap; this lets the storage layer
 * filter at the value-shape boundary before invoking AES.
 */
export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as EncryptedBlob).nonce === 'string' &&
    typeof (value as EncryptedBlob).ciphertext === 'string'
  )
}
