// ABOUTME: Pure rules for the launch team's window extension (extendWindow), mirroring the contract.
// ABOUTME: Validates a proposed new deadline and converts between unix seconds and UTC form inputs.

/** Below this much chain time to the current deadline, the panel warns the launch team. */
export const EXTEND_URGENT_SECONDS = 24 * 3600

/**
 * The operational extension step: +5 days per extension, at most two (5 + 5 + 5 = the 15-day
 * cap). The contract enforces only the cap (specs/CROWDFUND.md, "Extension steps"). Mirrors
 * EXTENSION_STEP_SECONDS in scripts/safe-batch.ts, which cf-safe-extend uses on the Safe path.
 */
export const EXTENSION_STEP_SECONDS = 5 * 24 * 3600

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
 * `error` means the transaction would revert. `warnings` are for a valid extension that needs
 * care: little time is left to get it mined before the current deadline (after which extension
 * is impossible), or the new end is not one EXTENSION_STEP_SECONDS past the current end, to the
 * input's minute precision (the operational step rule, which the contract does not enforce).
 */
export function checkExtension(t: WindowTiming, newEnd: number): { error: string | null; warnings: string[] } {
  if (t.now > t.windowEnd) return { error: 'The window has ended; it can no longer be extended.', warnings: [] }
  if (newEnd <= t.windowEnd) return { error: 'The new end must be later than the current end.', warnings: [] }
  if (newEnd > maxWindowEnd(t)) return { error: 'The new end is past the maximum window end.', warnings: [] }
  const warnings: string[] = []
  if (t.windowEnd - t.now < EXTEND_URGENT_SECONDS) {
    warnings.push('Less than 24h left: the transaction must be mined before the current end, or the window can never be extended.')
  }
  // The date input has minute precision, so when the current end has seconds the closest end it
  // can express (and the +5 days preset fills) is up to 59s short of the exact step.
  const step = newEnd - t.windowEnd
  const shortfall = EXTENSION_STEP_SECONDS - step
  if (shortfall < 0 || shortfall >= 60) {
    const days = Number((step / 86400).toFixed(2))
    warnings.push(`The new end is ${days} days after the current end; the operational rule is +5 days per extension, at most two (specs/CROWDFUND.md, "Extension steps"). Confirm this is intended and record it in the decision log.`)
  }
  return { error: null, warnings }
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
