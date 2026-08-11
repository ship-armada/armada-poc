// ABOUTME: Tests for lib/address validators — positive + negative cases for EVM and shielded address shapes.
// ABOUTME: Mixed-case + whitespace tolerance is exercised explicitly since users frequently paste with trailing spaces.

import { describe, it, expect } from 'vitest'
import { isEvmAddress, validateEvmAddress, isShieldedAddress, validateShieldedAddressStrict } from './address'

// Canonical EIP-55 checksummed address from the spec's test vectors.
const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

describe('isEvmAddress', () => {
  it('accepts a valid lowercase address (no checksum to verify)', () => {
    expect(isEvmAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(true)
  })
  it('accepts a correctly EIP-55-checksummed mixed-case address', () => {
    expect(isEvmAddress(CHECKSUMMED)).toBe(true)
  })
  it('rejects a mixed-case address with a bad EIP-55 checksum (typo guard)', () => {
    // WHY (P1 hygiene): a pure shape check waves through a transposed/mistyped character. The
    // checksum catches it. Flip one cased char of the canonical address → checksum no longer matches.
    expect(isEvmAddress('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(false)
  })
  it('trims surrounding whitespace', () => {
    expect(isEvmAddress('  0x1234567890abcdef1234567890abcdef12345678  ')).toBe(true)
  })
  it('rejects missing prefix', () => {
    expect(isEvmAddress('1234567890abcdef1234567890abcdef12345678')).toBe(false)
  })
  it('rejects wrong length', () => {
    expect(isEvmAddress('0x1234')).toBe(false)
  })
  it('rejects non-hex chars', () => {
    expect(isEvmAddress('0xZZZZ567890abcdef1234567890abcdef12345678')).toBe(false)
  })
  it('rejects empty string', () => {
    expect(isEvmAddress('')).toBe(false)
  })
})

describe('validateEvmAddress', () => {
  it('categorises a shape failure', () => {
    expect(validateEvmAddress('0x1234')).toEqual({ valid: false, error: 'shape' })
  })
  it('categorises a checksum failure distinctly from a shape failure', () => {
    expect(validateEvmAddress('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toEqual({
      valid: false,
      error: 'checksum',
    })
  })
  it('accepts a correctly checksummed address with no error', () => {
    expect(validateEvmAddress(CHECKSUMMED)).toEqual({ valid: true })
  })
})

describe('isShieldedAddress', () => {
  it('accepts a 0zk-prefixed alphanumeric string of sufficient length', () => {
    expect(isShieldedAddress('0zk' + 'a'.repeat(40))).toBe(true)
  })
  it('rejects 0zk with too-short payload', () => {
    expect(isShieldedAddress('0zkshort')).toBe(false)
  })
  it('rejects EVM addresses', () => {
    expect(isShieldedAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(false)
  })
  it('rejects empty string', () => {
    expect(isShieldedAddress('')).toBe(false)
  })
})

describe('validateShieldedAddressStrict', () => {
  it('rejects obviously-malformed input via the fast pre-filter (no SDK load)', async () => {
    // WHY: the shape pre-filter short-circuits before the dynamic SDK import, so junk input is
    // rejected cheaply (and the test doesn't drag the jsdom-hostile SDK into the run).
    expect(await validateShieldedAddressStrict('not-an-address')).toBe(false)
    expect(await validateShieldedAddressStrict('0x1234')).toBe(false)
    expect(await validateShieldedAddressStrict('0zkshort')).toBe(false)
  })
})
