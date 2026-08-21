// ABOUTME: USDC amount input with `display` (big serif numeral) and `compact` variants, MAX shortcut, AVAILABLE caption, inline errors, AND a keystroke sanitizer that rejects characters that wouldn't form a valid USDC amount.
// ABOUTME: Sanitizer is the first line of defence; parseUsdcInput's categorised errors are the safety net for programmatic/paste paths the sanitizer can't catch.

import { useId } from 'react'
import { formatUsdcAmount, formatUsdcPlain } from '@/lib/format'
import styles from './AmountInput.module.css'

export type AmountInputVariant = 'compact' | 'display'

/** USDC has 6 decimals; if you ever want a non-USDC amount input, generalise this prop instead of forking the component. */
const DEFAULT_MAX_DECIMALS = 6

export interface AmountInputProps {
  /** Controlled raw input string (free typing). Use parseUsdcInput to convert before submit. */
  value: string
  onValueChange: (next: string) => void
  /** Maximum spendable amount (raw 6-decimal bigint). Drives the AVAILABLE caption + MAX button. */
  max?: bigint
  /** Label rendered above the input. */
  label?: string
  /** Unit suffix in the display variant (e.g. "USDC"). Hidden in compact. */
  unit?: string
  variant?: AmountInputVariant
  disabled?: boolean
  /** Error message rendered below the input. */
  error?: string
  /** Optional onBlur — useful for normalising the typed value (trim trailing dots, etc.). */
  onBlur?: () => void
}

/**
 * Sanitize a candidate value (typed or pasted) into a valid USDC input string. Returns null if
 * the candidate cannot be coerced (caller should reject the keystroke entirely).
 *
 *  - Strips characters outside `[0-9.]`
 *  - Allows at most one decimal point (extras are dropped)
 *  - Truncates the fractional portion to `maxDecimals` chars
 *  - Allows intermediate states the user needs to type forward: `''`, `'.'` (becomes `'0.'`),
 *    `'1.'`, `'0.'`
 *
 * Pasting "1.123456789" returns "1.123456" — silent truncation only on paste, which matches
 * browser conventions for similar number-like inputs. Typing a 7th decimal character returns
 * null and the keystroke is rejected (no state update, cursor doesn't move).
 */
function sanitizeAmountInput(
  candidate: string,
  previous: string,
  maxDecimals: number,
): string | null {
  // Strip everything outside digits and decimal points. Doing this BEFORE the dot check lets us
  // accept pastes like "$1.50" or "1,500.00" — the formatting characters are dropped and we
  // keep the numeric content. Comma is intentionally NOT treated as a decimal separator (locale
  // ambiguity would silently misparse European amounts).
  const stripped = candidate.replace(/[^0-9.]/g, '')

  // Reduce multiple decimal points to one — keeps the first occurrence so typing "1.5" then
  // hitting "." again is a no-op rather than rewriting the value.
  const firstDot = stripped.indexOf('.')
  const normalised = firstDot === -1
    ? stripped
    : stripped.slice(0, firstDot + 1) + stripped.slice(firstDot + 1).replace(/\./g, '')

  if (firstDot !== -1) {
    const fractional = normalised.slice(firstDot + 1)
    if (fractional.length > maxDecimals) {
      // Pasted-too-many-decimals: truncate the fractional portion to the limit. Typing the 7th
      // character explicitly would also land here; either way we return the truncated value so
      // the user sees their intent partially honoured (the leading content is preserved).
      // Reject (return null) only when the truncation would produce no change from the previous
      // value — that's the "user hit a key that did nothing" case and we want React to skip the
      // state update so cursor position doesn't jitter.
      const truncated = normalised.slice(0, firstDot + 1 + maxDecimals)
      return truncated === previous ? null : truncated
    }
  }

  return normalised === previous ? null : normalised
}

export function AmountInput({
  value,
  onValueChange,
  max,
  label,
  unit = 'USDC',
  variant = 'compact',
  disabled,
  error,
  onBlur,
}: AmountInputProps) {
  const id = useId()
  const hasMax = max !== undefined
  const helperTextId = useId()

  function handleChange(raw: string) {
    const sanitized = sanitizeAmountInput(raw, value, DEFAULT_MAX_DECIMALS)
    // null = the keystroke would have been a no-op after sanitization; skip the state update so
    // the cursor stays put and the user gets the standard "this key didn't do anything" UX.
    if (sanitized === null) return
    onValueChange(sanitized)
  }

  function setMax() {
    if (max === undefined) return
    onValueChange(formatUsdcPlain(max))
  }

  if (variant === 'display') {
    return (
      <div className={styles.displayRoot}>
        {label ? (
          <label htmlFor={id} className={styles.label}>
            {label}
          </label>
        ) : null}
        <div className={styles.displayRow}>
          <input
            id={id}
            className={styles.displayInput}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={value}
            onChange={e => handleChange(e.target.value)}
            onBlur={onBlur}
            disabled={disabled}
            placeholder="0"
            aria-label={label ?? 'Amount'}
            aria-describedby={helperTextId}
          />
          <span className={styles.unit}>{unit}</span>
        </div>
        <div className={styles.helperText} id={helperTextId}>
          USDC has up to 6 decimal places
        </div>
        {hasMax ? (
          <div className={styles.captions}>
            <span className={styles.captionAvailable}>
              AVAILABLE {formatUsdcAmount(max)}
            </span>
            <button
              type="button"
              onClick={setMax}
              className={styles.maxBtn}
              disabled={disabled}
            >
              MAX
            </button>
          </div>
        ) : null}
        {error ? (
          <div role="alert" className={styles.error}>
            {error}
          </div>
        ) : null}
      </div>
    )
  }

  // compact variant
  return (
    <div className={styles.compactRoot}>
      {label ? (
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
      ) : null}
      <div className={styles.compactRow}>
        <input
          id={id}
          className={styles.compactInput}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          value={value}
          onChange={e => handleChange(e.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          placeholder="0.00"
          aria-label={label ?? 'Amount'}
        />
        {hasMax ? (
          <button
            type="button"
            onClick={setMax}
            className={styles.compactMaxBtn}
            disabled={disabled}
          >
            MAX
          </button>
        ) : null}
      </div>
      {hasMax ? (
        <div className={styles.compactAvailable}>
          Available {formatUsdcAmount(max)} USDC
        </div>
      ) : null}
      {error ? (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      ) : null}
    </div>
  )
}
