// ABOUTME: Unit tests for addressInput sanitization helpers.
// ABOUTME: Covers whitespace trimming, length capping, ENS charset, checksum validation.

import { describe, expect, it } from 'vitest'
import {
  ADDRESS_INPUT_MAX_LENGTH,
  isHexAddressFormat,
  isValidEnsName,
  sanitizeAddressInput,
  tryGetChecksumAddress,
} from './addressInput.js'

// Vitalik's address — a known-valid EIP-55 checksum, used as a stable fixture.
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

describe('sanitizeAddressInput', () => {
  it('trims leading and trailing whitespace', () => {
    expect(sanitizeAddressInput(`  ${VITALIK}  `)).toBe(VITALIK)
  })

  it('strips a pasted newline', () => {
    expect(sanitizeAddressInput(`${VITALIK}\n`)).toBe(VITALIK)
  })

  it('caps at ADDRESS_INPUT_MAX_LENGTH chars', () => {
    const long = 'a'.repeat(ADDRESS_INPUT_MAX_LENGTH + 50)
    expect(sanitizeAddressInput(long).length).toBe(ADDRESS_INPUT_MAX_LENGTH)
  })

  it('preserves casing for checksum validation', () => {
    expect(sanitizeAddressInput(VITALIK)).toBe(VITALIK)
  })

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeAddressInput('   ')).toBe('')
  })
})

describe('isHexAddressFormat', () => {
  it('accepts a valid 0x-prefixed 40-hex-char string', () => {
    expect(isHexAddressFormat(VITALIK)).toBe(true)
  })

  it('accepts all-lowercase', () => {
    expect(isHexAddressFormat(VITALIK.toLowerCase())).toBe(true)
  })

  it('rejects missing 0x prefix', () => {
    expect(isHexAddressFormat(VITALIK.slice(2))).toBe(false)
  })

  it('rejects non-hex characters', () => {
    expect(isHexAddressFormat('0xZZZZ' + VITALIK.slice(6))).toBe(false)
  })

  it('rejects wrong length (39 chars)', () => {
    expect(isHexAddressFormat(VITALIK.slice(0, -1))).toBe(false)
  })

  it('rejects wrong length (41 chars)', () => {
    expect(isHexAddressFormat(VITALIK + '0')).toBe(false)
  })
})

describe('tryGetChecksumAddress', () => {
  it('returns canonical checksum form for a valid address', () => {
    expect(tryGetChecksumAddress(VITALIK)).toBe(VITALIK)
  })

  it('normalizes all-lowercase to checksum form', () => {
    expect(tryGetChecksumAddress(VITALIK.toLowerCase())).toBe(VITALIK)
  })

  it('rejects a mixed-case address with a bad checksum', () => {
    // Swap one casing pair so the checksum no longer validates.
    const bad = VITALIK.replace('d8dA', 'D8dA')
    expect(tryGetChecksumAddress(bad)).toBe(null)
  })

  it('rejects malformed input', () => {
    expect(tryGetChecksumAddress('not an address')).toBe(null)
  })

  it('rejects empty string', () => {
    expect(tryGetChecksumAddress('')).toBe(null)
  })
})

describe('isValidEnsName', () => {
  it('accepts a simple .eth name', () => {
    expect(isValidEnsName('vitalik.eth')).toBe(true)
  })

  it('accepts a subdomain', () => {
    expect(isValidEnsName('alice.armada.eth')).toBe(true)
  })

  it('accepts hyphens inside a label', () => {
    expect(isValidEnsName('al-ice.eth')).toBe(true)
  })

  it('accepts mixed case (ENSIP-15 normalization happens at the resolver)', () => {
    expect(isValidEnsName('Vitalik.eth')).toBe(true)
  })

  it('accepts emoji labels', () => {
    expect(isValidEnsName('\u{1F984}.eth')).toBe(true)
  })

  it('accepts Unicode / IDN labels', () => {
    expect(isValidEnsName('münchen.eth')).toBe(true)
  })

  it('rejects a name not ending in .eth', () => {
    expect(isValidEnsName('vitalik.xyz')).toBe(false)
  })

  it('rejects leading whitespace', () => {
    expect(isValidEnsName(' vitalik.eth')).toBe(false)
  })

  it('rejects mid-string whitespace', () => {
    expect(isValidEnsName('alice .eth')).toBe(false)
  })

  it('rejects an embedded ASCII control character (tab)', () => {
    expect(isValidEnsName('alice\t.eth')).toBe(false)
  })

  it('rejects an embedded ASCII control character (NUL)', () => {
    expect(isValidEnsName('alice\x00.eth')).toBe(false)
  })

  it('rejects an embedded ASCII control character (DEL)', () => {
    expect(isValidEnsName('alice\x7f.eth')).toBe(false)
  })

  it('rejects empty label (double dot)', () => {
    expect(isValidEnsName('vitalik..eth')).toBe(false)
  })

  it('rejects bare .eth with no label', () => {
    expect(isValidEnsName('.eth')).toBe(false)
  })

  it('rejects extremely long input', () => {
    const long = 'a'.repeat(ADDRESS_INPUT_MAX_LENGTH) + '.eth'
    expect(isValidEnsName(long)).toBe(false)
  })
})
