// ABOUTME: Sanitization / parse helpers for free-form decimal amount inputs (Step2Commit + multi-hop rows).
// ABOUTME: Ported from the armada-crowdfund mockup (src/utils/amountInput.ts) — same shape, same semantics. Lets the input live as a string so mid-decimal entry ("0.", "1.") doesn't flicker the dependent UI.

/** Sanitize free-form decimal entry (digits + single dot). */
export function sanitizeAmountInput(raw: string): string {
  const normalized = raw.replace(/,/g, '')
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
