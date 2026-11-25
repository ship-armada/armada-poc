// ABOUTME: Tests for the window-extension rules and UTC input conversion used by ExtendWindowPanel.
// ABOUTME: Mirrors the contract's extendWindow() checks so the panel never sends a reverting transaction.

import { EXTEND_URGENT_SECONDS, EXTENSION_STEP_SECONDS, checkExtension, maxWindowEnd, parseUtcInput, toUtcInput, type WindowTiming } from './windowExtension'

const DAY = 86400
/** Opened at day 0, ends at day 7, maximum end day 14, now day 3. */
const timing = (overrides: Partial<WindowTiming> = {}): WindowTiming => ({
  windowStart: 0, windowEnd: 7 * DAY, now: 3 * DAY, maxWindowDuration: 14 * DAY, ...overrides,
})

describe('checkExtension', () => {
  // WHY: the contract accepts any later end up to windowStart + MAX_WINDOW_DURATION inclusive.
  it('accepts a later end within the maximum, including exactly the maximum', () => {
    expect(checkExtension(timing(), 9 * DAY).error).toBeNull()
    expect(checkExtension(timing(), maxWindowEnd(timing())).error).toBeNull()
  })

  // WHY: the launch team extends in +5-day steps (specs/CROWDFUND.md, "Extension steps"). The
  // contract allows any step, so an off-rule end is a warning, not an error, matching cf-safe-extend.
  it('warns when the new end is not exactly one +5-day step past the current end', () => {
    expect(checkExtension(timing(), 7 * DAY + EXTENSION_STEP_SECONDS)).toEqual({ error: null, warnings: [] })
    const offRule = checkExtension(timing(), 9 * DAY)
    expect(offRule.error).toBeNull()
    expect(offRule.warnings).toEqual([expect.stringMatching(/2 days after the current end; the operational rule is \+5 days/)])
  })

  // WHY: the date input has minute precision, so when the current end has seconds (any deploy not
  // opened on a whole minute) the +5 days preset lands up to 59s short; that is still the step.
  it('treats an end within a minute short of the +5-day step as on the step', () => {
    const end = 7 * DAY + 23
    const t = timing({ windowEnd: end })
    expect(checkExtension(t, end + EXTENSION_STEP_SECONDS - 23).warnings).toEqual([])
    expect(checkExtension(t, end + EXTENSION_STEP_SECONDS - 59).warnings).toEqual([])
    expect(checkExtension(t, end + EXTENSION_STEP_SECONDS - 60).warnings).toHaveLength(1)
    expect(checkExtension(t, end + EXTENSION_STEP_SECONDS + 1).warnings).toHaveLength(1)
  })

  // WHY: each of these would revert on chain; the panel must block the button instead.
  it('rejects an end that is not later, is past the maximum, or comes after the window ended', () => {
    expect(checkExtension(timing(), 7 * DAY).error).toMatch(/later than the current end/)
    expect(checkExtension(timing(), 6 * DAY).error).toMatch(/later than the current end/)
    expect(checkExtension(timing(), 14 * DAY + 1).error).toMatch(/past the maximum/)
    expect(checkExtension(timing({ now: 7 * DAY + 1 }), 9 * DAY).error).toMatch(/can no longer be extended/)
  })

  // WHY: at exactly windowEnd the window is still open (commits allow <= windowEnd), so it is extendable.
  it('allows extending at the final second of the window', () => {
    expect(checkExtension(timing({ now: 7 * DAY }), 9 * DAY).error).toBeNull()
  })

  // WHY: a transaction mined after the deadline can never be retried, so close calls must be flagged.
  it('warns when less than 24h of chain time is left', () => {
    const fiveDaysOn = 7 * DAY + EXTENSION_STEP_SECONDS
    expect(checkExtension(timing({ now: 7 * DAY - EXTEND_URGENT_SECONDS + 60 }), fiveDaysOn).warnings)
      .toEqual([expect.stringMatching(/Less than 24h/)])
    expect(checkExtension(timing({ now: 7 * DAY - EXTEND_URGENT_SECONDS }), fiveDaysOn).warnings).toEqual([])
  })
})

describe('UTC input conversion', () => {
  // WHY: datetime-local values carry no timezone; reading them as local time would shift the
  // deadline by the operator's UTC offset.
  it('reads a datetime-local value as UTC and round-trips', () => {
    const unix = Date.UTC(2026, 11, 1, 16, 0) / 1000
    expect(parseUtcInput('2026-12-01T16:00')).toBe(unix)
    expect(toUtcInput(unix)).toBe('2026-12-01T16:00')
  })

  it('rejects empty, partial, and impossible dates', () => {
    for (const bad of ['', '2026-12-01', '2026-12-01T16:00:00', '2026-13-01T16:00', '2026-02-30T10:00']) {
      expect(parseUtcInput(bad)).toBeNull()
    }
  })
})
