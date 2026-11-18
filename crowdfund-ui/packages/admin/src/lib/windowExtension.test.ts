// ABOUTME: Tests for the window-extension rules and UTC input conversion used by ExtendWindowPanel.
// ABOUTME: Mirrors the contract's extendWindow() checks so the panel never sends a reverting transaction.

import { EXTEND_URGENT_SECONDS, checkExtension, maxWindowEnd, parseUtcInput, toUtcInput, type WindowTiming } from './windowExtension'

const DAY = 86400
/** Opened at day 0, ends at day 7, maximum end day 14, now day 3. */
const timing = (overrides: Partial<WindowTiming> = {}): WindowTiming => ({
  windowStart: 0, windowEnd: 7 * DAY, now: 3 * DAY, maxWindowDuration: 14 * DAY, ...overrides,
})

describe('checkExtension', () => {
  // WHY: the contract accepts any later end up to windowStart + MAX_WINDOW_DURATION inclusive.
  it('accepts a later end within the maximum, including exactly the maximum', () => {
    expect(checkExtension(timing(), 9 * DAY)).toEqual({ error: null, warning: null })
    expect(checkExtension(timing(), maxWindowEnd(timing()))).toEqual({ error: null, warning: null })
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
    expect(checkExtension(timing({ now: 7 * DAY - EXTEND_URGENT_SECONDS + 60 }), 9 * DAY).warning).toMatch(/Less than 24h/)
    expect(checkExtension(timing({ now: 7 * DAY - EXTEND_URGENT_SECONDS }), 9 * DAY).warning).toBeNull()
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
