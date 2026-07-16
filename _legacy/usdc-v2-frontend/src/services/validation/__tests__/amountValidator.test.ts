/**
 * Tests for amount validator.
 */

import { describe, it, expect } from 'vitest'
import { validateAmount } from '../amountValidator'

describe('amountValidator', () => {
  describe('validateAmount', () => {
    describe('empty and whitespace handling', () => {
      it('should return error for empty string', () => {
        const result = validateAmount('')
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Please enter an amount')
      })

      it('should return error for whitespace-only string', () => {
        const result = validateAmount('   ')
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Please enter an amount')
      })
    })

    describe('format validation', () => {
      it('should reject scientific notation by default', () => {
        const result = validateAmount('1e6')
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Scientific notation')
      })

      it('should reject scientific notation with uppercase E', () => {
        const result = validateAmount('1E6')
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('Scientific notation')
      })

      it('should allow scientific notation when explicitly allowed', () => {
        const result = validateAmount('1e6', { allowScientificNotation: true })
        expect(result.isValid).toBe(true)
      })

      it('should reject multiple decimal points', () => {
        const result = validateAmount('10.5.0')
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Please enter a valid amount')
      })

      it('should reject non-numeric strings', () => {
        const result = validateAmount('abc')
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Please enter a valid amount')
      })

      it('should reject strings with non-numeric characters', () => {
        const result = validateAmount('10.5abc')
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Please enter a valid amount')
      })
    })

    describe('positive number validation', () => {
      it('should reject zero', () => {
        const result = validateAmount('0')
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Amount must be greater than zero')
      })

      it('should reject negative numbers', () => {
        const result = validateAmount('-10')
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Amount must be greater than zero')
      })

      it('should accept positive integers', () => {
        const result = validateAmount('10')
        expect(result.isValid).toBe(true)
        expect(result.value).toBe('10')
      })

      it('should accept positive decimals', () => {
        const result = validateAmount('10.5')
        expect(result.isValid).toBe(true)
        expect(result.value).toBe('10.5')
      })
    })

    describe('decimal precision validation', () => {
      it('should accept amount with default max decimals (6)', () => {
        const result = validateAmount('10.123456')
        expect(result.isValid).toBe(true)
      })

      it('should reject amount with too many decimals (default 6)', () => {
        const result = validateAmount('10.1234567')
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('cannot have more than 6 decimal places')
      })

      it('should accept amount with custom max decimals', () => {
        const result = validateAmount('10.12', { maxDecimals: 2 })
        expect(result.isValid).toBe(true)
      })

      it('should reject amount exceeding custom max decimals', () => {
        const result = validateAmount('10.123', { maxDecimals: 2 })
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('cannot have more than 2 decimal places')
      })

      it('should normalize trailing zeros', () => {
        const result = validateAmount('10.00')
        expect(result.isValid).toBe(true)
        expect(result.value).toBe('10')
      })

      it('should normalize trailing zeros in decimals', () => {
        const result = validateAmount('10.50')
        expect(result.isValid).toBe(true)
        expect(result.value).toBe('10.5')
      })
    })

    describe('minimum amount validation', () => {
      it('should reject amount below minimum', () => {
        const result = validateAmount('0.5', { minAmount: 1 })
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('must be at least')
      })

      it('should accept amount at minimum', () => {
        const result = validateAmount('1', { minAmount: 1 })
        expect(result.isValid).toBe(true)
      })

      it('should accept amount above minimum', () => {
        const result = validateAmount('10', { minAmount: 1 })
        expect(result.isValid).toBe(true)
      })

      it('should accept minimum as string', () => {
        const result = validateAmount('1', { minAmount: '0.5' })
        expect(result.isValid).toBe(true)
      })
    })

    describe('maximum amount validation', () => {
      it('should reject amount exceeding maximum', () => {
        const result = validateAmount('100', { maxAmount: 50 })
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('exceeds maximum')
      })

      it('should accept amount at maximum', () => {
        const result = validateAmount('50', { maxAmount: 50 })
        expect(result.isValid).toBe(true)
      })

      it('should accept amount below maximum', () => {
        const result = validateAmount('10', { maxAmount: 50 })
        expect(result.isValid).toBe(true)
      })

      it('should accept maximum as string', () => {
        const result = validateAmount('10', { maxAmount: '50' })
        expect(result.isValid).toBe(true)
      })
    })

    describe('balance check with fees', () => {
      it('should reject amount + fee exceeding balance', () => {
        const result = validateAmount('95', {
          maxAmount: '100',
          estimatedFee: '10',
        })
        expect(result.isValid).toBe(false)
        expect(result.error).toContain('exceeds available balance')
      })

      it('should accept amount + fee within balance', () => {
        const result = validateAmount('90', {
          maxAmount: '100',
          estimatedFee: '10',
        })
        expect(result.isValid).toBe(true)
      })

      it('should reject when fee alone exceeds balance', () => {
        const result = validateAmount('1', {
          maxAmount: '5',
          estimatedFee: '10',
        })
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Insufficient balance to cover fees')
      })

      it('should handle fee as string', () => {
        const result = validateAmount('90', {
          maxAmount: '100',
          estimatedFee: '10',
        })
        expect(result.isValid).toBe(true)
      })
    })

    describe('edge cases', () => {
      it('should handle very small amounts', () => {
        const result = validateAmount('0.000001')
        expect(result.isValid).toBe(true)
      })

      it('should handle very large amounts', () => {
        const result = validateAmount('999999999.99')
        expect(result.isValid).toBe(true)
      })

      it('should handle leading zeros', () => {
        const result = validateAmount('0010.5')
        expect(result.isValid).toBe(true)
        expect(result.value).toBe('0010.5') // Leading zeros preserved
      })

      it('should handle amounts with only decimal part', () => {
        const result = validateAmount('.5')
        expect(result.isValid).toBe(true)
        expect(result.value).toBe('0.5')
      })
    })

    describe('custom error messages', () => {
      it('should use custom empty error message', () => {
        const result = validateAmount('', {
          errorMessages: { empty: 'Custom empty message' },
        })
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Custom empty message')
      })

      it('should use custom invalid format error message', () => {
        const result = validateAmount('abc', {
          errorMessages: { invalidFormat: 'Custom format message' },
        })
        expect(result.isValid).toBe(false)
        expect(result.error).toBe('Custom format message')
      })
    })
  })
})

