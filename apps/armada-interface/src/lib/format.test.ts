// ABOUTME: Unit tests for lib/format — covers USDC formatting, address truncation, and relative-time bucketing.
// ABOUTME: Relative-time tests inject `now` so the buckets are deterministic across runs.

import { describe, it, expect } from 'vitest'
import {
  formatUsdc,
  formatUsdcPlain,
  formatUsdcAmount,
  parseUsdcInput,
  truncateAddress,
  formatRelativeTime,
  usdcInputErrorMessage,
} from './format'

describe('formatUsdc', () => {
  it('formats a raw 6-decimal amount as a dollar string', () => {
    expect(formatUsdc(1_500_000n)).toBe('$1.5')
    expect(formatUsdc(1_000_000_000_000n)).toBe('$1,000,000')
  })
})

describe('formatUsdcPlain', () => {
  it('returns a plain decimal string suitable for inputs', () => {
    expect(formatUsdcPlain(2_500_000n)).toBe('2.5')
    expect(formatUsdcPlain(0n)).toBe('0')
  })
})

describe('formatUsdcAmount', () => {
  it('formats with thousand separators and 2 decimal places by default', () => {
    expect(formatUsdcAmount(12_481_220_000n)).toBe('12,481.22')
    expect(formatUsdcAmount(0n)).toBe('0.00')
  })
  it('honors a custom decimals option', () => {
    expect(formatUsdcAmount(1_234_567_890n, { decimals: 4 })).toBe('1,234.5679')
    expect(formatUsdcAmount(1_500_000n, { decimals: 0 })).toBe('2')
  })
  it('reveals sub-cent precision (2–6 fraction digits) by default', () => {
    // Committed figures (fees, net, totals) must not round a real sub-cent value away to "0.00".
    expect(formatUsdcAmount(500_000n)).toBe('0.50') // whole cents keep the 2-decimal minimum
    expect(formatUsdcAmount(1_004_000n)).toBe('1.004') // sub-cent tenths shown
    expect(formatUsdcAmount(496_905_432n)).toBe('496.905432') // full 6-decimal precision when present
    expect(formatUsdcAmount(1n)).toBe('0.000001') // the smallest USDC unit is visible, not "0.00"
  })
})

describe('parseUsdcInput', () => {
  it('parses a decimal string to raw 6-decimal bigint with no error', () => {
    expect(parseUsdcInput('1')).toEqual({ value: 1_000_000n })
    expect(parseUsdcInput('0.5')).toEqual({ value: 500_000n })
    expect(parseUsdcInput('1.123456')).toEqual({ value: 1_123_456n })
  })

  it('returns { value: 0n } with no error for the empty / whitespace input (user hasn\'t typed yet)', () => {
    // Critical: empty input is NOT an error — it's the initial state. Modals gate Continue on
    // `value > 0n`; setting error here would surface a spurious "invalid number" before the
    // user has even typed anything.
    expect(parseUsdcInput('')).toEqual({ value: 0n })
    expect(parseUsdcInput('   ')).toEqual({ value: 0n })
  })

  it('reports too-many-decimals BEFORE numeric truncation would silently lose precision', () => {
    // The whole reason for the new API: previously "1.1234567" silently parsed as 1_123_456n
    // (loses the trailing 7). Now it surfaces an error so UI can prompt the user instead.
    expect(parseUsdcInput('1.1234567')).toEqual({ value: 0n, error: 'too-many-decimals' })
    expect(parseUsdcInput('0.0000001')).toEqual({ value: 0n, error: 'too-many-decimals' })
  })

  it('accepts exactly 6 decimal places (boundary)', () => {
    expect(parseUsdcInput('1.123456')).toEqual({ value: 1_123_456n })
    expect(parseUsdcInput('0.000001')).toEqual({ value: 1n })
  })

  it('reports invalid for non-numeric input', () => {
    expect(parseUsdcInput('abc')).toEqual({ value: 0n, error: 'invalid' })
    expect(parseUsdcInput('NaN')).toEqual({ value: 0n, error: 'invalid' })
  })

  it('reports negative for negative numbers', () => {
    expect(parseUsdcInput('-5')).toEqual({ value: 0n, error: 'negative' })
    expect(parseUsdcInput('-0.01')).toEqual({ value: 0n, error: 'negative' })
  })

  it('reports invalid for non-finite values (Infinity, very large exponents)', () => {
    // parseFloat accepts these silently; without the isFinite guard, BigInt(Infinity) throws.
    expect(parseUsdcInput('Infinity')).toEqual({ value: 0n, error: 'invalid' })
    expect(parseUsdcInput('1e500')).toEqual({ value: 0n, error: 'invalid' })
  })

  it('parses with exact decimal precision — no float rounding (P1-21)', () => {
    // WHY: the parseFloat impl returned 8164999n for "8.165" because 8.165 * 1e6 is
    // 8164999.99… in IEEE-754 and Math.floor dropped the last cent. Pure decimal-string
    // assembly is exact. These three are the locked regression cases for the bug.
    expect(parseUsdcInput('8.165')).toEqual({ value: 8_165_000n })
    expect(parseUsdcInput('1.000001')).toEqual({ value: 1_000_001n })
    expect(parseUsdcInput('1e3')).toEqual({ value: 0n, error: 'invalid' })
  })

  it('rejects malformed decimal shapes as invalid', () => {
    // WHY: pure-string parsing must reject grouping commas, multiple dots, a lone dot, and a
    // leading '+' — none of which are valid raw USDC amounts — rather than coercing them.
    expect(parseUsdcInput('1,000')).toEqual({ value: 0n, error: 'invalid' })
    expect(parseUsdcInput('1.2.3')).toEqual({ value: 0n, error: 'invalid' })
    expect(parseUsdcInput('.')).toEqual({ value: 0n, error: 'invalid' })
    expect(parseUsdcInput('+5')).toEqual({ value: 0n, error: 'invalid' })
  })

  it('accepts bare leading/trailing dot forms exactly', () => {
    // ".5" → 0.5 USDC, "5." → 5 USDC. Both are unambiguous and must assemble exactly.
    expect(parseUsdcInput('.5')).toEqual({ value: 500_000n })
    expect(parseUsdcInput('5.')).toEqual({ value: 5_000_000n })
  })
})

describe('usdcInputErrorMessage', () => {
  it('returns undefined for the no-error case so callers can chain `?? otherError`', () => {
    expect(usdcInputErrorMessage(undefined)).toBeUndefined()
  })

  it('maps each error code to user-visible copy', () => {
    expect(usdcInputErrorMessage('too-many-decimals')).toMatch(/6 decimal/)
    expect(usdcInputErrorMessage('negative')).toMatch(/negative/i)
    expect(usdcInputErrorMessage('invalid')).toMatch(/valid number/i)
  })
})

describe('truncateAddress', () => {
  it('truncates a long address to 6+4 chars', () => {
    expect(truncateAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234...5678')
  })
  it('returns short strings unchanged', () => {
    expect(truncateAddress('0x1234')).toBe('0x1234')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-05-19T12:00:00Z').getTime()

  it('returns "just now" for recent timestamps', () => {
    expect(formatRelativeTime(now - 1000, now)).toBe('just now')
  })

  it('formats seconds ago', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('30s ago')
  })

  it('formats minutes ago', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
  })

  it('formats hours ago', () => {
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe('3h ago')
  })

  it('says "Yesterday" for ~1 day ago', () => {
    expect(formatRelativeTime(now - 24 * 3600_000, now)).toBe('Yesterday')
  })

  it('formats days ago up to a week', () => {
    expect(formatRelativeTime(now - 3 * 24 * 3600_000, now)).toBe('3d ago')
  })

  it('falls back to absolute date for older timestamps', () => {
    const older = new Date('2026-03-14T12:00:00Z').getTime()
    expect(formatRelativeTime(older, now)).toMatch(/Mar 14/)
  })

  it('handles future timestamps', () => {
    expect(formatRelativeTime(now + 30_000, now)).toBe('in 30s')
    expect(formatRelativeTime(now + 24 * 3600_000, now)).toBe('Tomorrow')
  })
})
