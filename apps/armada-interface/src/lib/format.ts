// ABOUTME: Address + USDC formatters. Kept in LOCKSTEP with crowdfund-ui/packages/shared/src/lib/format.ts (parseUsdcInput, formatUsdc, formatUsdcPlain, truncateAddress) — any change to those four must land in both files in the same PR.
// ABOUTME: Once a third consumer needs these or the apps need to diverge, extract to @armada/eth-utils per Plan §19. Tracked in .claude/ARMADA_INTERFACE_POLISH.md.

/** Format a USDC raw amount (6 decimals) as a dollar string, e.g. "$1,200,000". */
export function formatUsdc(amount: bigint): string {
  const dollars = Number(amount) / 1e6
  return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/** Format USDC raw amount as a plain number string (for input fields). */
export function formatUsdcPlain(amount: bigint): string {
  return (Number(amount) / 1e6).toString()
}

/**
 * Format a USDC raw amount as a locale-grouped number string.
 *
 * Default (no `decimals`): 2–6 fraction digits — normal amounts read "12,481.22", but sub-cent
 * precision (down to USDC's 1e-6 unit) is revealed when present, so committed figures (fees, net,
 * totals, wallet-signature labels) never round a real sub-cent value away to "0.00". Pass a fixed
 * `decimals` where a rigid width is wanted (e.g. a strict 2dp caption).
 */
export function formatUsdcAmount(amount: bigint, options?: { decimals?: number }): string {
  const dollars = Number(amount) / 1e6
  if (options?.decimals !== undefined) {
    return dollars.toLocaleString('en-US', {
      minimumFractionDigits: options.decimals,
      maximumFractionDigits: options.decimals,
    })
  }
  return dollars.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })
}

/**
 * Categorised parse error returned from {@link parseUsdcInput}. Surfaced via the result's
 * `error` field; `value` is always present (0n on error) so the common UI gating pattern
 * `value > 0n` still works without immediate caller changes.
 *
 *  'invalid'           — not a plain decimal ("abc", "NaN", "Infinity", scientific notation like
 *                        "1e3", a leading "+", grouping commas, multiple dots, or a lone ".")
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
 *
 * `AmountInput`'s keystroke sanitizer should prevent invalid input from reaching here in the
 * normal flow; this parser is the defence-in-depth layer (programmatic submission, malformed
 * paste, future API surfaces).
 */
export function parseUsdcInput(input: string): UsdcInputResult {
  const trimmed = input.trim()
  if (trimmed === '') return { value: 0n }

  // Categorize a leading '-' as 'negative' before the shape check so "-5" / "-0.01" report
  // 'negative' rather than 'invalid'.
  if (trimmed.startsWith('-')) return { value: 0n, error: 'negative' }

  // Pure decimal-string parsing — NO parseFloat/Number. parseFloat loses precision at 6dp:
  // parseFloat("8.165") * 1e6 is 8164999.99…, which Math.floor'd to 8164999 (off by one). We
  // validate the shape (optional integer part, optional single dot, optional fraction) then
  // assemble the raw bigint from the digit groups directly, so the result is exact. The shape
  // check also rejects scientific notation ("1e3"), a leading "+", grouping commas, multiple
  // dots, and a lone ".".
  if (trimmed === '.' || !/^\d*\.?\d*$/.test(trimmed)) {
    return { value: 0n, error: 'invalid' }
  }

  const dot = trimmed.indexOf('.')
  const whole = dot === -1 ? trimmed : trimmed.slice(0, dot)
  const frac = dot === -1 ? '' : trimmed.slice(dot + 1)

  // >6 fractional digits would lose precision — surface 'too-many-decimals' rather than truncate.
  if (frac.length > 6) return { value: 0n, error: 'too-many-decimals' }

  const wholePart = whole === '' ? 0n : BigInt(whole)
  const fracPart = frac === '' ? 0n : BigInt(frac.padEnd(6, '0'))
  return { value: wholePart * 1_000_000n + fracPart }
}

/**
 * Map a {@link UsdcInputError} to the user-visible copy we surface in AmountInput. Armada-local
 * helper — copy may differ across apps so this isn't part of the lockstep contract with
 * crowdfund-shared. Returns undefined when no error so the caller can pass it through to
 * AmountInput.error without an extra conditional.
 *
 * Defensive: AmountInput's keystroke sanitizer prevents these errors in the normal flow. Users
 * see this copy only when bypassing the sanitizer (programmatic state injection, future surfaces).
 */
export function usdcInputErrorMessage(error: UsdcInputError | undefined): string | undefined {
  switch (error) {
    case 'too-many-decimals': return 'USDC has at most 6 decimal places.'
    case 'negative': return "Amounts can't be negative."
    case 'invalid': return 'Enter a valid number.'
    case undefined: return undefined
  }
}

const TRANSACTION_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

const TRANSACTION_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
})

/** Single-line absolute date and time for transaction confirmations, e.g. "Jan 5, 2026 · 3:42 PM". */
export function formatTransactionDateTime(ms: number): string {
  const date = new Date(ms)
  return `${TRANSACTION_DATE_FORMAT.format(date)} · ${TRANSACTION_TIME_FORMAT.format(date)}`
}

/** Truncate an Ethereum address to "0x1234...abcd" (mockup convention: 6 chars before, 4 after). */
export function truncateAddress(address: string): string {
  if (address.length <= 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/** Truncate to first/last six characters, e.g. "0x6C62...F87B9". */
export function truncateAddressEnds(address: string, head = 6, tail = 6): string {
  if (address.length <= head + tail + 3) return address
  return `${address.slice(0, head)}...${address.slice(-tail)}`
}

/** Shielded / Armada zk address — slightly longer tail for readability. */
export function truncateArmadaAddress(address: string): string {
  if (address.length <= 15) return address
  return `${address.slice(0, 6)}...${address.slice(-6)}`
}

/**
 * Compact relative-time formatter — "just now" / "12s ago" / "5m ago" / "3h ago" / "Yesterday" / "Mar 14".
 *
 * Pure / no React. `now` is injectable for deterministic tests; defaults to Date.now().
 * Future tense is supported (negative diffs) → "in 2m", "in 1h".
 */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const diffMs = now - ms
  const future = diffMs < 0
  const abs = Math.abs(diffMs)
  const s = Math.round(abs / 1000)

  if (s < 10) return future ? 'in a moment' : 'just now'
  if (s < 60) return future ? `in ${s}s` : `${s}s ago`

  const m = Math.round(s / 60)
  if (m < 60) return future ? `in ${m}m` : `${m}m ago`

  const h = Math.round(m / 60)
  if (h < 24) return future ? `in ${h}h` : `${h}h ago`

  const d = Math.round(h / 24)
  if (d === 1) return future ? 'Tomorrow' : 'Yesterday'
  if (d < 7) return future ? `in ${d}d` : `${d}d ago`

  // Fall back to absolute formatting for older timestamps. "Mar 14" / "Mar 14, 2024" (if not this year).
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
