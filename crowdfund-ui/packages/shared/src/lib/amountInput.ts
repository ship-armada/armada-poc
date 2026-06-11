// ABOUTME: Sanitization / parse helpers for free-form decimal amount inputs (Step2Commit + multi-hop rows).
// ABOUTME: Ported from the armada-crowdfund mockup (src/utils/amountInput.ts) — same shape, same semantics. Lets the input live as a string so mid-decimal entry ("0.", "1.") doesn't flicker the dependent UI.

/** A fully thousands-grouped number, optionally with a decimal part.
 *  e.g. "1,000", "12,345.67", "1,234,567". NOT "1,5" / "1,00" / "1000,". */
const THOUSANDS_GROUPED = /^\d{1,3}(,\d{3})*(\.\d*)?$/

/**
 * Sanitize free-form decimal entry (digits + single dot).
 *
 * Commas are accepted ONLY as valid thousands separators (e.g. "1,000"); any
 * other comma usage is rejected (returns '') rather than silently
 * reinterpreted — so the European decimal "1,5" never becomes 15. Non-numeric
 * noise ($, spaces, letters) is dropped first so "$1,000 USD" still yields
 * "1000".
 */
export function sanitizeAmountInput(raw: string): string {
  // Drop everything except digits, commas, and dots before reasoning about commas.
  const cleaned = raw.replace(/[^0-9.,]/g, '')

  let normalized: string
  if (cleaned.includes(',')) {
    if (THOUSANDS_GROUPED.test(cleaned)) {
      normalized = cleaned.replace(/,/g, '')
    } else {
      // Ambiguous / invalid comma usage — reject rather than guess.
      return ''
    }
  } else {
    normalized = cleaned
  }

  let out = ''
  let seenDecimal = false
  for (const char of normalized) {
    if (char >= '0' && char <= '9') {
      out += char
      continue
    }
    if (char === '.' && !seenDecimal) {
      seenDecimal = true
      out += char
    }
  }
  return out
}

/** True when the input contains a comma that is NOT a valid thousands
 *  separator — used to show inline "use a period for decimals" feedback. */
export function isInvalidCommaInput(raw: string): boolean {
  const cleaned = raw.replace(/[^0-9.,]/g, '')
  return cleaned.includes(',') && !THOUSANDS_GROUPED.test(cleaned)
}

/** True when the user has a non-zero amount or is mid-decimal entry (e.g. "0."). */
export function hasActiveAmount(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.') return false
  if (trimmed.endsWith('.')) return true
  const num = parseFloat(trimmed)
  return !Number.isNaN(num) && num !== 0
}

/** Parse active input to a capped numeric amount; zero when inactive or invalid. */
export function parseActiveAmount(value: string, cap = Infinity): number {
  if (!hasActiveAmount(value)) return 0
  const num = parseFloat(value)
  if (Number.isNaN(num)) return 0
  return Math.min(Math.max(0, num), cap)
}
