// ABOUTME: Unit tests for formatting utilities.
// ABOUTME: Tests USDC, ARM, address, countdown, and phase formatting.
import { describe, it, expect } from 'vitest'
import {
  formatUsdc,
  formatUsdcPlain,
  parseUsdcInput,
  formatArm,
  truncateAddress,
  formatCountdown,
  phaseName,
  phaseColor,
  hopLabel,
} from './format'
import { Phase } from '@/types/crowdfund'

describe('formatUsdc', () => {
  it('formats zero', () => {
    expect(formatUsdc(0n)).toBe('$0.00')
  })

  it('formats whole dollars', () => {
    expect(formatUsdc(15_000_000_000n)).toBe('$15,000.00')
  })

  it('formats fractional amounts', () => {
    expect(formatUsdc(1_500_000n)).toBe('$1.50')
  })

  it('formats large amounts', () => {
    expect(formatUsdc(1_200_000_000_000n)).toBe('$1,200,000.00')
  })
})

describe('formatUsdcPlain', () => {
  it('returns plain number string', () => {
    expect(formatUsdcPlain(15_000_000_000n)).toBe('15000')
  })
})

describe('parseUsdcInput', () => {
  it('parses integer input', () => {
    expect(parseUsdcInput('15000')).toBe(15_000_000_000n)
  })

  it('parses decimal input', () => {
    expect(parseUsdcInput('1.50')).toBe(1_500_000n)
  })

  it('returns 0 for invalid input', () => {
    expect(parseUsdcInput('')).toBe(0n)
    expect(parseUsdcInput('abc')).toBe(0n)
    expect(parseUsdcInput('-100')).toBe(0n)
  })
})

describe('formatArm', () => {
  it('formats ARM tokens', () => {
    expect(formatArm(15_000_000_000_000_000_000_000n)).toBe('15,000 ARM')
  })

  it('formats zero', () => {
    expect(formatArm(0n)).toBe('0 ARM')
  })
})

describe('truncateAddress', () => {
  it('truncates standard address', () => {
    expect(truncateAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'))
      .toBe('0xf39F...2266')
  })

  it('returns short strings unchanged', () => {
    expect(truncateAddress('0x1234')).toBe('0x1234')
  })
})

describe('formatCountdown', () => {
  it('formats days, hours, minutes', () => {
    const twoDaysAndHalf = 2 * 86400 + 14 * 3600 + 30 * 60
    expect(formatCountdown(twoDaysAndHalf)).toBe('2d 14h 30m')
  })

  it('formats hours and minutes only', () => {
    expect(formatCountdown(3661)).toBe('1h 1m')
  })

  it('returns expired for zero or negative', () => {
    expect(formatCountdown(0)).toBe('expired')
    expect(formatCountdown(-100)).toBe('expired')
  })

  it('formats minutes only', () => {
    expect(formatCountdown(120)).toBe('2m')
  })
})

describe('phaseName', () => {
  it('returns correct names', () => {
    expect(phaseName(Phase.Active)).toBe('Active')
    expect(phaseName(Phase.Finalized)).toBe('Finalized')
    expect(phaseName(Phase.Canceled)).toBe('Canceled')
  })
})

describe('phaseColor', () => {
  it('returns non-empty class strings', () => {
    expect(phaseColor(Phase.Active)).toContain('info')
    expect(phaseColor(Phase.Finalized)).toContain('success')
    expect(phaseColor(Phase.Canceled)).toContain('destructive')
  })
})

describe('hopLabel', () => {
  it('returns correct labels', () => {
    expect(hopLabel(0)).toBe('Seed (hop-0)')
    expect(hopLabel(1)).toBe('Hop-1')
    expect(hopLabel(2)).toBe('Hop-2')
  })
})
