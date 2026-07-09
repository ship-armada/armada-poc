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
