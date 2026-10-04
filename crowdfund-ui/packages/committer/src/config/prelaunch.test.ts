// ABOUTME: Unit tests for pre-launch mode — VITE_PRELAUNCH_OPENS_AT parsing and the post-opening reload check.
// ABOUTME: A malformed value must never be read as a real opening time.
import { describe, it, expect } from 'vitest'
import { isValidPrelaunchOpensAt, parsePrelaunchOpensAt, prelaunchShouldReload } from './prelaunch'

// Thu 2026-10-08 17:00:00 UTC.
const OPENS_AT = 1791478800

describe('isValidPrelaunchOpensAt', () => {
  it('accepts ISO 8601 UTC with whole seconds and a trailing Z, trimming whitespace', () => {
    expect(isValidPrelaunchOpensAt('2026-10-08T17:00:00Z')).toBe(true)
    expect(isValidPrelaunchOpensAt(' 2026-10-08T17:00:00Z ')).toBe(true)
  })

  it('rejects a time without an explicit UTC Z (would parse as device-local time)', () => {
    expect(isValidPrelaunchOpensAt('2026-10-08T17:00:00')).toBe(false)
    expect(isValidPrelaunchOpensAt('2026-10-08T17:00:00+00:00')).toBe(false)
  })

  it('rejects unix timestamps, date-only values, fractions and calendar overflow', () => {
    expect(isValidPrelaunchOpensAt('1791478800')).toBe(false)
    expect(isValidPrelaunchOpensAt('2026-10-08')).toBe(false)
    expect(isValidPrelaunchOpensAt('2026-10-08T17:00:00.000Z')).toBe(false)
    expect(isValidPrelaunchOpensAt('2026-13-08T17:00:00Z')).toBe(false)
    expect(isValidPrelaunchOpensAt('2026-02-30T17:00:00Z')).toBe(false)
  })
})

describe('parsePrelaunchOpensAt', () => {
  it('returns null when the var is unset or blank (normal app)', () => {
    expect(parsePrelaunchOpensAt(undefined)).toBeNull()
    expect(parsePrelaunchOpensAt('')).toBeNull()
    expect(parsePrelaunchOpensAt('   ')).toBeNull()
  })

  it('returns the opening time in unix seconds for a valid value', () => {
    expect(parsePrelaunchOpensAt('2026-10-08T17:00:00Z')).toBe(OPENS_AT)
  })

  it('returns null for a malformed value (validateEnv reports it)', () => {
    expect(parsePrelaunchOpensAt('1791478800')).toBeNull()
    expect(parsePrelaunchOpensAt('next thursday')).toBeNull()
  })
})

describe('prelaunchShouldReload', () => {
  it('does not reload before the opening', () => {
    expect(prelaunchShouldReload(OPENS_AT, OPENS_AT * 1000 - 1)).toBe(false)
  })

  it('reloads at and after the opening, so open tabs pick up the live deploy', () => {
    expect(prelaunchShouldReload(OPENS_AT, OPENS_AT * 1000)).toBe(true)
    expect(prelaunchShouldReload(OPENS_AT, OPENS_AT * 1000 + 3_600_000)).toBe(true)
  })
})
