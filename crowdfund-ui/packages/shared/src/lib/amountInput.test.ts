// ABOUTME: Unit tests for the amount-input helpers (sanitize / has-active / parse).
// ABOUTME: Covers mid-decimal entry, comma handling, capping, and zero/empty boundaries.

import { describe, it, expect } from 'vitest'
import { sanitizeAmountInput, hasActiveAmount, parseActiveAmount } from './amountInput'

describe('sanitizeAmountInput', () => {
  it('passes through digits unchanged', () => {
    expect(sanitizeAmountInput('1234')).toBe('1234')
  })

  it('strips commas (thousand separators on paste)', () => {
    expect(sanitizeAmountInput('1,234,567')).toBe('1234567')
  })

  it('keeps the first decimal point and drops subsequent ones', () => {
    expect(sanitizeAmountInput('1.2.3')).toBe('1.23')
  })

  it('drops non-numeric characters', () => {
    expect(sanitizeAmountInput('$1,000 USD')).toBe('1000')
  })

  it('preserves a trailing decimal point so mid-decimal typing works', () => {
    expect(sanitizeAmountInput('5.')).toBe('5.')
  })

  it('returns empty for empty input', () => {
    expect(sanitizeAmountInput('')).toBe('')
  })

  it('allows a leading decimal point', () => {
    expect(sanitizeAmountInput('.5')).toBe('.5')
  })
})

describe('hasActiveAmount', () => {
  it('is false for empty string', () => {
    expect(hasActiveAmount('')).toBe(false)
  })

  it('is false for a lone decimal point', () => {
    expect(hasActiveAmount('.')).toBe(false)
  })

  it('is false for "0"', () => {
    expect(hasActiveAmount('0')).toBe(false)
  })

  it('is true for mid-decimal "0." (user is typing 0.something)', () => {
    expect(hasActiveAmount('0.')).toBe(true)
  })

  it('is true for any positive numeric string', () => {
    expect(hasActiveAmount('1')).toBe(true)
    expect(hasActiveAmount('100.5')).toBe(true)
  })

  it('trims whitespace before checking', () => {
    expect(hasActiveAmount('   5  ')).toBe(true)
    expect(hasActiveAmount('   0  ')).toBe(false)
  })
})

describe('parseActiveAmount', () => {
  it('returns 0 when the input is empty / "." / "0"', () => {
    expect(parseActiveAmount('')).toBe(0)
    expect(parseActiveAmount('.')).toBe(0)
    expect(parseActiveAmount('0')).toBe(0)
  })

  it('returns 0 for a non-numeric string', () => {
    expect(parseActiveAmount('abc')).toBe(0)
  })

  it('parses a numeric string to its float', () => {
    expect(parseActiveAmount('123.45')).toBe(123.45)
  })

  it('caps to the supplied maximum', () => {
    expect(parseActiveAmount('500', 100)).toBe(100)
  })

  it('does not cap when the supplied max is Infinity (default)', () => {
    expect(parseActiveAmount('1000000')).toBe(1000000)
  })

  it('returns 0 for negative-looking input (sanitize strips the sign upstream)', () => {
    // `sanitizeAmountInput` drops `-`; passing `-5` directly to `parseActiveAmount`
    // exercises the clamp lower bound directly.
    expect(parseActiveAmount('-5')).toBe(0)
  })

  it('parses a trailing-dot string as the integer portion', () => {
    expect(parseActiveAmount('7.', 1000)).toBe(7)
  })
})
