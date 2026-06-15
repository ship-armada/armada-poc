// ABOUTME: Unit tests for formatting utilities.
// ABOUTME: Covers USDC/ARM formatting, address truncation, countdown, phase/hop labels.

import { describe, it, expect } from 'vitest'
import {
  formatUsdc,
  formatUsdcPlain,
  parseUsdcInput,
  formatArm,
  truncateAddress,
  formatCountdown,
  formatTimeLeft,
  formatTimeLeftDetail,
  hopLabel,
  phaseName,
  phaseColor,
} from './format.js'

describe('formatUsdc', () => {
  it('formats zero', () => {
    expect(formatUsdc(0n)).toBe('$0')
  })

  it('formats whole dollar amounts', () => {
    expect(formatUsdc(1_200_000n * 10n ** 6n)).toBe('$1,200,000')
  })

  it('formats amounts with cents', () => {
    expect(formatUsdc(15_000_500_000n)).toBe('$15,000.5')
  })

  it('formats small amounts', () => {
    expect(formatUsdc(10n * 10n ** 6n)).toBe('$10')
  })
})

describe('formatUsdcPlain', () => {
  it('formats without dollar sign', () => {
    expect(formatUsdcPlain(15_000n * 10n ** 6n)).toBe('15000')
  })

  it('formats zero', () => {
    expect(formatUsdcPlain(0n)).toBe('0')
  })

  it('formats fractional amounts', () => {
    expect(formatUsdcPlain(1_500_000n)).toBe('1.5')
  })
})

describe('parseUsdcInput', () => {
  // New result-type API kept in lockstep with apps/armada-interface/src/lib/format.ts.
  // See that file's tests for the full rationale; cases here mirror the same matrix so any
  // future divergence is caught immediately.

  it('parses whole numbers', () => {
    expect(parseUsdcInput('15000')).toEqual({ value: 15_000n * 10n ** 6n })
  })

  it('parses decimal amounts', () => {
    expect(parseUsdcInput('15000.50')).toEqual({ value: 15_000_500_000n })
  })

  it('returns no error for empty / whitespace (user hasn\'t typed yet)', () => {
    expect(parseUsdcInput('')).toEqual({ value: 0n })
    expect(parseUsdcInput('   ')).toEqual({ value: 0n })
  })

  it('reports invalid for non-numeric input', () => {
    expect(parseUsdcInput('abc')).toEqual({ value: 0n, error: 'invalid' })
  })

  it('reports negative for negative numbers', () => {
    expect(parseUsdcInput('-100')).toEqual({ value: 0n, error: 'negative' })
  })

  it('reports too-many-decimals before silent truncation would lose precision', () => {
    expect(parseUsdcInput('1.1234567')).toEqual({ value: 0n, error: 'too-many-decimals' })
  })

  it('accepts exactly 6 decimal places (boundary)', () => {
    expect(parseUsdcInput('1.123456')).toEqual({ value: 1_123_456n })
  })

  it('scales without float error (string-based, not Math.floor)', () => {
    // 8469.8 * 1e6 === 8469799999.999… — Math.floor would drop a µUSDC.
    expect(parseUsdcInput('8469.8')).toEqual({ value: 8_469_800_000n })
    expect(parseUsdcInput('1026.82')).toEqual({ value: 1_026_820_000n })
  })

  it('handles a leading decimal and trailing dot', () => {
    expect(parseUsdcInput('.5')).toEqual({ value: 500_000n })
    expect(parseUsdcInput('5.')).toEqual({ value: 5_000_000n })
  })

  it('parses zero', () => {
    expect(parseUsdcInput('0')).toEqual({ value: 0n })
  })
})

describe('formatArm', () => {
  it('formats ARM amounts', () => {
    expect(formatArm(1_200_000n * 10n ** 18n)).toBe('1,200,000 ARM')
  })

  it('formats zero', () => {
    expect(formatArm(0n)).toBe('0 ARM')
  })
})

describe('truncateAddress', () => {
  it('truncates standard address', () => {
    expect(truncateAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe('0xf39F...2266')
  })

  it('returns short strings unchanged', () => {
    expect(truncateAddress('0x1234')).toBe('0x1234')
  })
})

describe('formatCountdown', () => {
  it('shows expired for zero or negative', () => {
    expect(formatCountdown(0)).toBe('expired')
    expect(formatCountdown(-100)).toBe('expired')
  })

  it('shows days and hours', () => {
    expect(formatCountdown(6 * 86400 + 14 * 3600)).toBe('6d 14h')
  })

  it('shows hours and minutes', () => {
    expect(formatCountdown(2 * 3600 + 30 * 60)).toBe('2h 30m')
  })

  it('shows minutes only', () => {
    expect(formatCountdown(45 * 60)).toBe('45m')
  })

  it('shows 0m for very short durations', () => {
    expect(formatCountdown(30)).toBe('0m')
  })
})

describe('formatTimeLeft', () => {
  it('returns empty string at or past the deadline', () => {
    expect(formatTimeLeft(0)).toBe('')
    expect(formatTimeLeft(-100)).toBe('')
    expect(formatTimeLeft(Number.NaN)).toBe('')
  })

  it('shows whole days only while at least one day remains (floors)', () => {
    // 2d16h floors to "2 days" — no rounding up to 3.
    expect(formatTimeLeft(2 * 86400 + 16 * 3600)).toBe('2 days')
    expect(formatTimeLeft(2 * 86400)).toBe('2 days')
  })

  it('uses the singular for exactly one day', () => {
    expect(formatTimeLeft(86400)).toBe('1 day')
    expect(formatTimeLeft(86400 + 23 * 3600)).toBe('1 day')
  })

  it('drops to hours and minutes under one day', () => {
    expect(formatTimeLeft(13 * 3600 + 24 * 60)).toBe('13h 24m')
    expect(formatTimeLeft(3600)).toBe('1h 0m')
  })

  it('shows minutes only under one hour', () => {
    expect(formatTimeLeft(9 * 60)).toBe('9m')
  })

  it('rounds a sub-minute sliver up to 1m so it never reads 0m', () => {
    expect(formatTimeLeft(30)).toBe('1m')
  })
})

describe('formatTimeLeftDetail', () => {
  it('returns empty string at or past the deadline', () => {
    expect(formatTimeLeftDetail(0, 1_700_000_000)).toBe('')
    expect(formatTimeLeftDetail(-1, 1_700_000_000)).toBe('')
  })

  it('shows only the local end timestamp, prefixed with "Ends" and no year', () => {
    const detail = formatTimeLeftDetail(2 * 86400, 1_700_000_000)
    // The timestamp text is timezone-dependent, so assert the shape: an "Ends "
    // prefix, a 4-digit year nowhere in the string, and a single line.
    expect(detail.startsWith('Ends ')).toBe(true)
    expect(detail).not.toMatch(/\b\d{4}\b/)
    expect(detail).not.toContain('\n')
  })

  it('returns empty when the deadline is unknown', () => {
    expect(formatTimeLeftDetail(22 * 60, 0)).toBe('')
  })
})

describe('hopLabel', () => {
  it('labels hop 0 as Seed', () => {
    expect(hopLabel(0)).toBe('Seed (hop-0)')
  })

  it('labels hop 1', () => {
    expect(hopLabel(1)).toBe('Hop-1')
  })

  it('labels hop 2', () => {
    expect(hopLabel(2)).toBe('Hop-2')
  })

  it('handles unknown hops', () => {
    expect(hopLabel(3)).toBe('Hop-3')
  })
})

describe('phaseName', () => {
  it('returns Active for phase 0', () => {
    expect(phaseName(0)).toBe('Active')
  })

  it('returns Finalized for phase 1', () => {
    expect(phaseName(1)).toBe('Finalized')
  })

  it('returns Canceled for phase 2', () => {
    expect(phaseName(2)).toBe('Canceled')
  })

  it('returns Unknown for invalid phase', () => {
    expect(phaseName(99)).toBe('Unknown')
  })
})

describe('phaseColor', () => {
  it('returns info color for Active', () => {
    expect(phaseColor(0)).toContain('info')
  })

  it('returns success color for Finalized', () => {
    expect(phaseColor(1)).toContain('success')
  })

  it('returns destructive color for Canceled', () => {
    expect(phaseColor(2)).toContain('destructive')
  })

  it('returns muted for unknown phase', () => {
    expect(phaseColor(99)).toContain('muted')
  })
})
