// ABOUTME: Tests for cache-cipher — AES-256-GCM wrap/unwrap round-trip, BigInt sentinel handling, wrong-key + tampered-blob detection.

import { describe, it, expect } from 'vitest'
import { wrap, unwrap, isEncryptedBlob } from './cache-cipher'

function fixedKey(seed: number = 0): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = (seed + i) & 0xff
  return out
}

describe('wrap + unwrap', () => {
  it('round-trips a simple object', () => {
    const key = fixedKey()
    const blob = wrap({ a: 1, b: 'hello', c: [1, 2, 3] }, key)
    expect(blob.nonce.length).toBe(24) // 12 bytes = 24 hex chars
    expect(blob.ciphertext.length).toBeGreaterThan(0)
    const out = unwrap<{ a: number; b: string; c: number[] }>(blob, key)
    expect(out).toEqual({ a: 1, b: 'hello', c: [1, 2, 3] })
  })

  it('preserves BigInt values through the JSON sentinel', () => {
    const key = fixedKey()
    const blob = wrap({ amount: 1_000_000n, fee: 7n, plain: 42 }, key)
    const out = unwrap<{ amount: bigint; fee: bigint; plain: number }>(blob, key)
    expect(out.amount).toBe(1_000_000n)
    expect(typeof out.amount).toBe('bigint')
    expect(out.fee).toBe(7n)
    expect(typeof out.fee).toBe('bigint')
    expect(out.plain).toBe(42)
    expect(typeof out.plain).toBe('number')
  })

  it('handles deeply nested BigInts (arrays of objects)', () => {
    const key = fixedKey()
    const value = {
      records: [
        { amount: 1n, child: { nested: 100n } },
        { amount: 2n, child: { nested: 200n } },
      ],
    }
    const out = unwrap<typeof value>(wrap(value, key), key)
    expect(out.records[0]!.amount).toBe(1n)
    expect(out.records[0]!.child.nested).toBe(100n)
    expect(out.records[1]!.amount).toBe(2n)
  })

  it('produces a fresh nonce on every wrap (probabilistic — different ciphertexts for the same plaintext)', () => {
    const key = fixedKey()
    const a = wrap({ x: 1 }, key)
    const b = wrap({ x: 1 }, key)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('throws when wrapping with a wrong-size key', () => {
    expect(() => wrap({}, new Uint8Array(16))).toThrow()
    expect(() => wrap({}, new Uint8Array(64))).toThrow()
  })

  it('throws on unwrap with the wrong key (AES-GCM auth failure)', () => {
    const blob = wrap({ a: 1 }, fixedKey(0))
    expect(() => unwrap(blob, fixedKey(1))).toThrow()
  })

  it('throws on unwrap with a tampered ciphertext', () => {
    const key = fixedKey()
    const blob = wrap({ a: 1 }, key)
    const tampered = {
      nonce: blob.nonce,
      // flip the last hex nibble
      ciphertext: blob.ciphertext.slice(0, -1) + ((parseInt(blob.ciphertext.slice(-1), 16) ^ 1) & 0xf).toString(16),
    }
    expect(() => unwrap(tampered, key)).toThrow()
  })

  it('throws on unwrap with a wrong-size key', () => {
    const blob = wrap({}, fixedKey())
    expect(() => unwrap(blob, new Uint8Array(16))).toThrow()
  })

  it('throws on unwrap with malformed envelope (wrong nonce length)', () => {
    const blob = wrap({}, fixedKey())
    const malformed = { nonce: blob.nonce.slice(0, -2), ciphertext: blob.ciphertext }
    expect(() => unwrap(malformed, fixedKey())).toThrow()
  })
})

describe('isEncryptedBlob', () => {
  it('matches valid envelopes', () => {
    expect(isEncryptedBlob({ nonce: 'aa', ciphertext: 'bb' })).toBe(true)
  })

  it('rejects null + non-objects', () => {
    expect(isEncryptedBlob(null)).toBe(false)
    expect(isEncryptedBlob('string')).toBe(false)
    expect(isEncryptedBlob(42)).toBe(false)
  })

  it('rejects objects missing either field', () => {
    expect(isEncryptedBlob({ nonce: 'aa' })).toBe(false)
    expect(isEncryptedBlob({ ciphertext: 'bb' })).toBe(false)
  })

  it('rejects pre-Phase-7 plaintext TxRecord shapes (lets storage skip legacy)', () => {
    const legacyRecord = { id: 'x', kind: 'shield', executionState: 'completed' }
    expect(isEncryptedBlob(legacyRecord)).toBe(false)
  })
})
