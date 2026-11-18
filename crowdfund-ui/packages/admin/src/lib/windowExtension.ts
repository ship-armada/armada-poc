// ABOUTME: Pure rules for the launch team's window extension (extendWindow), mirroring the contract.
// ABOUTME: Validates a proposed new deadline and converts between unix seconds and UTC form inputs.

/** Below this much chain time to the current deadline, the panel warns the launch team. */
export const EXTEND_URGENT_SECONDS = 24 * 3600

export interface WindowTiming {
  windowStart: number
  windowEnd: number
  /** Current chain time (block timestamp), not the device clock. */
  now: number
  maxWindowDuration: number
}

/** Latest end extendWindow() accepts: windowStart + MAX_WINDOW_DURATION. */
export function maxWindowEnd(t: WindowTiming): number {
  return t.windowStart + t.maxWindowDuration
}

/**
 * Check a proposed new end against the contract's extendWindow() rules as of `t.now`.
 * `error` means the transaction would revert; `warning` means it is valid but little time
 * is left to get it mined before the current deadline (after which extension is impossible).
 */
export function checkExtension(t: WindowTiming, newEnd: number): { error: string | null; warning: string | null } {
  if (t.now > t.windowEnd) return { error: 'The window has ended; it can no longer be extended.', warning: null }
  if (newEnd <= t.windowEnd) return { error: 'The new end must be later than the current end.', warning: null }
  if (newEnd > maxWindowEnd(t)) return { error: 'The new end is past the maximum window end.', warning: null }
  const remaining = t.windowEnd - t.now
  const warning = remaining < EXTEND_URGENT_SECONDS
    ? `Less than 24h left: the transaction must be mined before the current end, or the window can never be extended.`
    : null
  return { error: null, warning }
}

/** "2026-12-01T16:00" (the datetime-local input format), in UTC. */
export function toUtcInput(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16)
}

/**
 * Parse a datetime-local value ("2026-12-01T16:00") as UTC, not local time, so the launch
 * team enters the same instant whatever their timezone. Returns null for anything else.
 */
export function parseUtcInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const ms = Date.parse(`${value}:00Z`)
  // The round-trip rejects calendar overflow (e.g. month 13) that Date.parse may normalize.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 16) !== value) return null
  return ms / 1000
}
