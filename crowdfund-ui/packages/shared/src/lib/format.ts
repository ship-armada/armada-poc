// ABOUTME: Formatting utilities for USDC amounts, ARM tokens, addresses, and countdowns. Pure functions, no React or ethers dependency.
// ABOUTME: parseUsdcInput / formatUsdc / formatUsdcPlain / truncateAddress are kept in LOCKSTEP with apps/armada-interface/src/lib/format.ts — any change must land in both files in the same PR. Tracked for eth-utils extraction in .claude/ARMADA_INTERFACE_POLISH.md.

/** Format a USDC amount (6 decimals) as a dollar string, e.g. "$1,200,000" */
export function formatUsdc(amount: bigint): string {
  const dollars = Number(amount) / 1e6
  return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/** Format USDC as a plain number string without dollar sign, for input fields */
export function formatUsdcPlain(amount: bigint): string {
  return (Number(amount) / 1e6).toString()
}

/**
 * Categorised parse error returned from {@link parseUsdcInput}. Surfaced via the result's
 * `error` field; `value` is always present (0n on error) so the common UI gating pattern
 * `value > 0n` still works.
 *
 *  'invalid'           — not a number (NaN, "abc", empty, scientific overflow like "1e500")
 *  'negative'          — number is negative
 *  'too-many-decimals' — input has more than 6 fractional digits; truncation would lose precision
 */
export type UsdcInputError = 'invalid' | 'negative' | 'too-many-decimals'

export interface UsdcInputResult {
  /** Parsed raw 6-decimal bigint. Always 0n when `error` is set. */
  value: bigint
  /** Categorised parse error; undefined when the input is a valid USDC amount. */
  error?: UsdcInputError
}

/**
 * Parse a USDC input string into a 6-decimal raw bigint with categorised errors.
 *
 * Unlike the previous string-truncating impl, this version distinguishes "the user hasn't typed
 * yet" (empty/0 → `{ value: 0n }`) from "the user typed something invalid" (e.g. >6dp →
 * `{ value: 0n, error: 'too-many-decimals' }`). UI surfaces the error via a dedicated inline
 * message instead of silently rounding.
 */
export function parseUsdcInput(input: string): UsdcInputResult {
  const trimmed = input.trim()
  if (trimmed === '') return { value: 0n }

  // Decimal-precision check happens BEFORE numeric parse so "1.1234567" reports 'too-many-decimals'
  // rather than silently rounding to 1.123456 via Math.floor below.
  const dot = trimmed.indexOf('.')
  if (dot !== -1 && trimmed.length - dot - 1 > 6) {
    return { value: 0n, error: 'too-many-decimals' }
  }

  const num = parseFloat(trimmed)
  // Reject non-finite (NaN, ±Infinity, "1e500"). parseFloat accepts "Infinity" silently;
  // without the isFinite guard, BigInt(Infinity) throws RangeError.
  if (!Number.isFinite(num)) return { value: 0n, error: 'invalid' }
  if (num < 0) return { value: 0n, error: 'negative' }

  // Scale to 6 decimals via string surgery, not float math: `8469.8 * 1e6` is
  // `8469799999.999…`, so `Math.floor` would yield 8469799999n (off by 1 µUSDC).
  // Decimals are already guaranteed ≤ 6 by the check above.
  const [wholePart, fracPart = ''] = trimmed.split('.')
  const whole = wholePart.replace(/^\+/, '') || '0'
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fracPart)) {
    // Non-plain-decimal (e.g. scientific notation) — fall back to a rounded
    // numeric scale rather than producing a malformed BigInt string.
    return { value: BigInt(Math.round(num * 1e6)) }
  }
  return { value: BigInt(whole + fracPart.padEnd(6, '0')) }
}

/** Format an ARM amount (18 decimals) as a token string, e.g. "1,200,000 ARM" */
export function formatArm(amount: bigint): string {
  const tokens = Number(amount) / 1e18
  return `${tokens.toLocaleString('en-US', { maximumFractionDigits: 2 })} ARM`
}

/** Truncate an Ethereum address to "0x1234...abcd" format */
export function truncateAddress(address: string): string {
  if (address.length <= 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/** Format a duration in seconds as a human-readable countdown, e.g. "6d 14h" */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'expired'

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/**
 * Crowdfund "time left" countdown shared by the stats banner, the hero progress
 * tag, and the invite splash so they always agree. Shows whole days until under
 * one day remains, then drops to hours + minutes. Floors throughout so the value
 * only ever ticks down. Returns '' at or past the deadline — callers supply their
 * own terminal wording (StatsBar → "Closed", the splash → "ENDS TODAY").
 *
 *   2 * 86400 + 16 * 3600  → "2 days"
 *   1 * 86400              → "1 day"
 *   13 * 3600 + 24 * 60    → "13h 24m"
 *   9 * 60                 → "9m"
 *   0                      → ""
 */
export function formatTimeLeft(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const days = Math.floor(seconds / 86400)
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours >= 1) return `${hours}h ${minutes}m`
  // Never show "0m left" while time genuinely remains — round the final
  // sub-minute sliver up to one minute.
  return `${Math.max(1, minutes)}m`
}

/** "May 28, 2:42 PM" (local) from a unix timestamp (seconds) — no year, so the
 *  tooltip stays on one line. Returns '' at or before 0. Internal helper for
 *  {@link formatTimeLeftDetail}. */
function formatEndDateTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return ''
  return new Date(unixSeconds * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Hover-tooltip detail for a crowdfund countdown: the local end timestamp, e.g.
 * "Ends Jun 14, 2:42 PM" (no year, fits on one line). Shared by the stats banner
 * and the hero progress tag so both tooltips read identically. `seconds` is the
 * remaining duration — used only to suppress the tooltip once the deadline has
 * passed; `windowEndUnix` is the absolute deadline (unix seconds). Returns '' at
 * or past the deadline, or when the deadline is unknown.
 */
export function formatTimeLeftDetail(seconds: number, windowEndUnix: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const end = formatEndDateTime(windowEndUnix)
  return end ? `Ends ${end}` : ''
}

/** Get human-readable phase name */
export function phaseName(phase: number): string {
  switch (phase) {
    case 0: return 'Active'
    case 1: return 'Finalized'
    case 2: return 'Canceled'
    default: return 'Unknown'
  }
}

/** Get Tailwind color classes for a phase badge */
export function phaseColor(phase: number): string {
  switch (phase) {
    case 0: return 'bg-info/20 text-info'
    case 1: return 'bg-success/20 text-success'
    case 2: return 'bg-destructive/20 text-destructive'
    default: return 'bg-muted text-muted-foreground'
  }
}

/** Get hop label for display */
export function hopLabel(hop: number): string {
  switch (hop) {
    case 0: return 'Seed (hop-0)'
    case 1: return 'Hop-1'
    case 2: return 'Hop-2'
    default: return `Hop-${hop}`
  }
}
