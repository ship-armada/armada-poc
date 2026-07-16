// ABOUTME: Tests for lib/crypto/hex — the shared nibble-based hex codec used on key-material paths.

import { describe, it, expect } from 'vitest'
import { bytesToHexNoPrefix, hexToBytesNoPrefix } from './hex'

describe('hex codec', () => {
  it('decodes a known vector exactly (matches the prior parseInt-based decoders)', () => {
    // WHY: the decoder replaced per-file parseInt loops; this pins byte-for-byte equality so the
    // refactor is provably behaviour-preserving on the key-material paths.
    expect(Array.from(hexToBytesNoPrefix('00ff10abCD'))).toEqual([0x00, 0xff, 0x10, 0xab, 0xcd])
  })

  it('strips an optional 0x / 0X prefix', () => {
    expect(Array.from(hexToBytesNoPrefix('0xdeadBEEF'))).toEqual([0xde, 0xad, 0xbe, 0xef])
    expect(Array.from(hexToBytesNoPrefix('0Xdeadbeef'))).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('round-trips bytes → hex → bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 128, 255])
    expect(Array.from(hexToBytesNoPrefix(bytesToHexNoPrefix(bytes)))).toEqual(Array.from(bytes))
  })

  it('encodes lowercase, zero-padded, no prefix', () => {
    expect(bytesToHexNoPrefix(new Uint8Array([0, 15, 255]))).toBe('000fff')
  })

  it('throws on odd length and non-hex characters', () => {
    expect(() => hexToBytesNoPrefix('abc')).toThrow(/even length/)
    expect(() => hexToBytesNoPrefix('zz')).toThrow(/invalid hex/)
  })
})
