/** Sanitize free-form decimal entry (digits + single dot), capped at USDC's 6 decimal places. */
export function sanitizeAmountInput(raw: string): string {
  const normalized = raw.replace(/,/g, '')
  let out = ''
  let seenDecimal = false
  let fractionDigits = 0
  for (const char of normalized) {
    if (char >= '0' && char <= '9') {
      // Cap the fractional portion at USDC's 6 decimals — drop a 7th digit rather than let it
      // fall through to parseUsdcInput's `too-many-decimals` error (which reads the amount as 0).
      if (seenDecimal) {
        if (fractionDigits >= 6) continue
        fractionDigits += 1
      }
      out += char
      continue
    }
    if (char === '.' && !seenDecimal) {
      seenDecimal = true
      out += char
    }
  }
  // Drop redundant leading zeros in the integer part ("05" → "5") while preserving a lone "0" and
  // the "0." a user needs to type a sub-one amount forward.
  return out.replace(/^0+(?=\d)/, '')
}

/**
 * Format a sanitized amount for display with en-US thousand grouping (1,000 / 1,000,000). The
 * decimal suffix is preserved verbatim (so mid-entry "1,000." keeps its trailing dot), and a bare
 * fraction gains a leading zero for display (".5" → "0.5"). The stored value stays ungrouped —
 * `sanitizeAmountInput` strips the commas back out on the next keystroke.
 */
export function formatAmountInputDisplay(sanitized: string): string {
  if (!sanitized) return ''
  const decimalIndex = sanitized.indexOf('.')
  const intPart = decimalIndex === -1 ? sanitized : sanitized.slice(0, decimalIndex)
  const decSuffix = decimalIndex === -1 ? '' : sanitized.slice(decimalIndex)
  if (!intPart) {
    return decSuffix ? `0${decSuffix}` : ''
  }
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${formattedInt}${decSuffix}`
}

/** True when the user has a non-zero amount or is mid-decimal entry (e.g. "0."). */
export function hasActiveAmount(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.') return false
  if (trimmed.endsWith('.')) return true
  const num = parseFloat(trimmed)
  return !Number.isNaN(num) && num !== 0
}
