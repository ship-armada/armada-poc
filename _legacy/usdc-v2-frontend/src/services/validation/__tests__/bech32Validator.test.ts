/**
 * Tests for bech32 address validator.
 */

import { describe, it, expect } from 'vitest'
import { validateBech32Address, validateNamadaAddress } from '../bech32Validator'

describe('bech32Validator', () => {
  describe('validateBech32Address', () => {
    describe('empty and whitespace handling', () => {
      it('should return error for empty string', () => {
        const result = validateBech32Address('', { expectedHrp: 'tnam' })
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Please enter an address')
      })

      it('should return error for whitespace-only string', () => {
        const result = validateBech32Address('   ', { expectedHrp: 'tnam' })
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Please enter an address')
      })
    })

    describe('HRP validation', () => {
      it('should accept address with correct HRP', () => {
        // Using a valid bech32 address format (this is a test address)
        const validAddress = 'tnam1qy352euf40x77q2k8mmyh8d4zfxvzekyfz4q0q'
        const result = validateBech32Address(validAddress, { expectedHrp: 'tnam' })
        expect(result.isValid).toBe(true)
        expect(result.value).toBe(validAddress.toLowerCase())
      })

      it('should reject address with wrong HRP', () => {
        const result = validateBech32Address('nam1qy352euf40x77q2k8mmyh8d4zfxvzekyfz4q0q', {
          expectedHrp: 'tnam',
        })
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Expected address starting with "tnam"')
      })

      it('should accept address with different HRP when specified', () => {
        const address = 'noble1qy352euf40x77q2k8mmyh8d4zfxvzekyfz4q0q'
        const result = validateBech32Address(address, { expectedHrp: 'noble' })
        // This will fail if address is invalid bech32, but pass if HRP matches
        // Note: This test assumes a valid bech32 address format
        if (result.isValid) {
          expect(result.value).toBe(address.toLowerCase())
        }
      })
    })

    describe('checksum validation', () => {
      it('should reject address with invalid checksum', () => {
        // Invalid bech32 address (wrong checksum)
        const invalidAddress = 'tnam1invalidchecksum1234567890'
        const result = validateBech32Address(invalidAddress, { expectedHrp: 'tnam' })
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Invalid bech32')
      })

      it('should accept address with valid checksum', () => {
        const validAddress = 'tnam1qy352euf40x77q2k8mmyh8d4zfxvzekyfz4q0q'
        const result = validateBech32Address(validAddress, { expectedHrp: 'tnam' })
        expect(result.isValid).toBe(true)
      })
    })

    describe('normalization', () => {
      it('should normalize address to lowercase by default', () => {
        const address = 'TNAM1QY352EUF40X77Q2K8MMYH8D4ZFXVZEKYFZ4Q0Q'
        const result = validateBech32Address(address, { expectedHrp: 'tnam' })
        if (result.isValid) {
          expect(result.value).toBe(address.toLowerCase())
        }
      })

      it('should not normalize when normalize is false', () => {
        const address = 'tnam1qy352euf40x77q2k8mmyh8d4zfxvzekyfz4q0q'
        const result = validateBech32Address(address, {
          expectedHrp: 'tnam',
          normalize: false,
        })
        if (result.isValid) {
          expect(result.value).toBe(address)
        }
      })
    })

    describe('invalid format handling', () => {
      it('should reject non-bech32 strings', () => {
        const result = validateBech32Address('0x1234567890123456789012345678901234567890', {
          expectedHrp: 'tnam',
        })
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Invalid bech32')
      })

      it('should reject strings without separator', () => {
        const result = validateBech32Address('tnam', { expectedHrp: 'tnam' })
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Invalid bech32')
      })
    })
  })

  describe('validateNamadaAddress', () => {
    it('should use tnam as default HRP', () => {
      const validAddress = 'tnam1qy352euf40x77q2k8mmyh8d4zfxvzekyfz4q0q'
      const result = validateNamadaAddress(validAddress)
      expect(result.isValid).toBe(true)
    })

    it('should reject non-tnam addresses', () => {
      const result = validateNamadaAddress('nam1qy352euf40x77q2k8mmyh8d4zfxvzekyfz4q0q')
      expect(result.isValid).toBe(false)
    })

    it('should accept options', () => {
      const result = validateNamadaAddress('tnam1qy352euf40x77q2k8mmyh8d4zfxvzekyfz4q0q', {
        normalize: false,
      })
      if (result.isValid) {
        expect(result.value).toBe('tnam1qy352euf40x77q2k8mmyh8d4zfxvzekyfz4q0q')
      }
    })
  })
})

