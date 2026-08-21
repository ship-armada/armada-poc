// ABOUTME: Unit tests for the deposit/send/earn amount-field sanitizer + active-amount predicate.
// ABOUTME: Covers digit/dot filtering, the 6-decimal cap, leading-zero collapse, and forward-typing states (0, ., 0.).

import { describe, it, expect } from 'vitest'
import { sanitizeAmountInput, hasActiveAmount, formatAmountInputDisplay } from './amountInput'

describe('sanitizeAmountInput', () => {
  it('keeps digits and a single decimal point', () => {
    expect(sanitizeAmountInput('12.34')).toBe('12.34')
    expect(sanitizeAmountInput('1.2.3')).toBe('1.23') // extra dots dropped
    expect(sanitizeAmountInput('$1,500.00')).toBe('1500.00') // strips commas + currency chars
    expect(sanitizeAmountInput('abc4d2')).toBe('42') // non-numeric stripped
  })

  it('preserves the forward-typing states needed for a sub-one amount', () => {
    // Regression: a leading `0`/`.` must survive so `0.5` / `.5` are typeable (previously discarded).
    expect(sanitizeAmountInput('0')).toBe('0')
    expect(sanitizeAmountInput('.')).toBe('.')
    expect(sanitizeAmountInput('0.')).toBe('0.')
    expect(sanitizeAmountInput('0.5')).toBe('0.5')
    expect(sanitizeAmountInput('.5')).toBe('.5')
  })

  it('collapses redundant leading zeros but keeps a lone 0 and 0.', () => {
    expect(sanitizeAmountInput('05')).toBe('5')
    expect(sanitizeAmountInput('007')).toBe('7')
    expect(sanitizeAmountInput('0')).toBe('0')
    expect(sanitizeAmountInput('00')).toBe('0')
    expect(sanitizeAmountInput('0.5')).toBe('0.5')
  })

  it('caps the fractional portion at 6 decimals (USDC precision)', () => {
    expect(sanitizeAmountInput('1.1234567')).toBe('1.123456') // 7th digit dropped
    expect(sanitizeAmountInput('1.123456')).toBe('1.123456') // exactly 6 kept
    expect(sanitizeAmountInput('0.0000001')).toBe('0.000000') // sub-1e-6 clamped, not errored
  })
})

describe('formatAmountInputDisplay', () => {
  it('groups the integer part with thousand separators', () => {
    expect(formatAmountInputDisplay('1000')).toBe('1,000')
    expect(formatAmountInputDisplay('1000000')).toBe('1,000,000')
    expect(formatAmountInputDisplay('1234567.89')).toBe('1,234,567.89')
  })
  it('preserves the decimal suffix verbatim (mid-entry dots survive)', () => {
    expect(formatAmountInputDisplay('1000.')).toBe('1,000.')
    expect(formatAmountInputDisplay('12.5')).toBe('12.5')
  })
  it('adds a leading zero to a bare fraction for display only', () => {
    expect(formatAmountInputDisplay('.5')).toBe('0.5')
    expect(formatAmountInputDisplay('.')).toBe('0.')
  })
  it('returns empty for empty input', () => {
    expect(formatAmountInputDisplay('')).toBe('')
  })
})

describe('hasActiveAmount', () => {
  it('is false for empty / zero / bare-dot states', () => {
    expect(hasActiveAmount('')).toBe(false)
    expect(hasActiveAmount('.')).toBe(false)
    expect(hasActiveAmount('0')).toBe(false)
    expect(hasActiveAmount('0.00')).toBe(false)
  })
  it('is true for a mid-decimal entry or any non-zero amount', () => {
    expect(hasActiveAmount('0.')).toBe(true) // mid-typing
    expect(hasActiveAmount('0.5')).toBe(true)
    expect(hasActiveAmount('10')).toBe(true)
  })
})
