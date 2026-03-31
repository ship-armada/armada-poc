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
  it('parses whole numbers', () => {
    expect(parseUsdcInput('15000')).toBe(15_000n * 10n ** 6n)
  })

  it('parses decimal amounts', () => {
    expect(parseUsdcInput('15000.50')).toBe(15_000_500_000n)
  })

  it('returns 0n for invalid input', () => {
    expect(parseUsdcInput('abc')).toBe(0n)
    expect(parseUsdcInput('')).toBe(0n)
  })

  it('returns 0n for negative input', () => {
    expect(parseUsdcInput('-100')).toBe(0n)
  })

  it('parses zero', () => {
    expect(parseUsdcInput('0')).toBe(0n)
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
