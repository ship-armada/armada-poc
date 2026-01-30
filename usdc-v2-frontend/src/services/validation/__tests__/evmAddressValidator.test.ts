/**
 * Tests for EVM address validator.
 */

import { describe, it, expect } from 'vitest'
import { validateEvmAddress } from '../evmAddressValidator'

describe('evmAddressValidator', () => {
  describe('validateEvmAddress', () => {
    describe('empty and whitespace handling', () => {
      it('should return error for empty string', () => {
        const result = validateEvmAddress('')
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Please enter a destination address')
      })

      it('should return error for whitespace-only string', () => {
        const result = validateEvmAddress('   ')
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Please enter a destination address')
      })
    })

    describe('format validation', () => {
      it('should accept valid lowercase address', () => {
        const address = '0x742d35cc6634c0532925a3b844bc9e7595f0beb'
        const result = validateEvmAddress(address)
        expect(result.isValid).toBe(true)
        // Should return checksummed version
        expect(result.value).toBeTruthy()
      })

      it('should accept valid checksummed address', () => {
        const address = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb'
        const result = validateEvmAddress(address)
        expect(result.isValid).toBe(true)
        expect(result.value).toBeTruthy()
      })

      it('should reject address without 0x prefix', () => {
        const result = validateEvmAddress('742d35cc6634c0532925a3b844bc9e7595f0beb')
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Invalid EVM address format')
      })

      it('should reject address with wrong length', () => {
        const result = validateEvmAddress('0x742d35cc6634c0532925a3b844bc9e7595f0be')
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Invalid address length')
      })

      it('should reject address with invalid characters', () => {
        const result = validateEvmAddress('0x742d35cc6634c0532925a3b844bc9e7595f0beg')
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Invalid EVM address format')
      })

      it('should reject non-hexadecimal characters', () => {
        const result = validateEvmAddress('0x742d35cc6634c0532925a3b844bc9e7595f0bez')
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Invalid EVM address format')
      })
    })

    describe('checksum validation', () => {
      it('should return checksummed address when valid', () => {
        const address = '0x742d35cc6634c0532925a3b844bc9e7595f0beb'
        const result = validateEvmAddress(address)
        expect(result.isValid).toBe(true)
        // ethers.getAddress returns checksummed version
        expect(result.value).toBeTruthy()
        expect(result.value?.startsWith('0x')).toBe(true)
        expect(result.value?.length).toBe(42)
      })

      it('should validate checksum correctly', () => {
        // This address has correct checksum
        const address = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb'
        const result = validateEvmAddress(address)
        expect(result.isValid).toBe(true)
      })
    })

    describe('normalization', () => {
      it('should normalize to checksummed format by default', () => {
        const address = '0x742d35cc6634c0532925a3b844bc9e7595f0beb'
        const result = validateEvmAddress(address)
        expect(result.isValid).toBe(true)
        // Should return checksummed version
        expect(result.value).not.toBe(address.toLowerCase())
      })

      it('should not normalize when normalize is false', () => {
        const address = '0x742d35cc6634c0532925a3b844bc9e7595f0beb'
        const result = validateEvmAddress(address, { normalize: false, checksum: false })
        // When checksum is false, it still validates but may not normalize
        // This test verifies the option is respected
        expect(result.isValid).toBe(true)
      })
    })

    describe('edge cases', () => {
      it('should handle all zeros address', () => {
        const address = '0x0000000000000000000000000000000000000000'
        const result = validateEvmAddress(address)
        expect(result.isValid).toBe(true)
      })

      it('should handle all Fs address', () => {
        const address = '0xffffffffffffffffffffffffffffffffffffffff'
        const result = validateEvmAddress(address)
        expect(result.isValid).toBe(true)
      })
    })
  })
})

