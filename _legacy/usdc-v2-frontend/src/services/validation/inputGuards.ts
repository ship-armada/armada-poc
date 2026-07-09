/**
 * Input guard utilities for preventing invalid characters from being typed.
 * These functions sanitize input in real-time as users type.
 */

/**
 * Sanitizes amount input to only allow numeric characters and a single decimal point.
 *
 * @param value - The input value
 * @param maxDecimals - Maximum number of decimal places allowed (default: 6)
 * @returns Sanitized value
 *
 * @example
 * ```ts
 * <input
 *   value={amount}
 *   onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
 * />
 * ```
 */
export function sanitizeAmountInput(value: string, maxDecimals: number = 6): string {
  // Remove all characters except digits and decimal point
  let sanitized = value.replace(/[^\d.]/g, '')

  // Only allow one decimal point
  const parts = sanitized.split('.')
  if (parts.length > 2) {
    // If multiple decimal points, keep only the first one
    sanitized = parts[0] + '.' + parts.slice(1).join('')
  }

  // Limit decimal places
  if (parts.length === 2 && parts[1].length > maxDecimals) {
    sanitized = parts[0] + '.' + parts[1].slice(0, maxDecimals)
  }

  return sanitized
}

/**
 * Sanitizes bech32 address input to only allow valid bech32 characters.
 * Bech32 uses base32 encoding: lowercase letters (a-z), digits (2-7), and separator '1'.
 * Also allows the HRP prefix (typically lowercase letters).
 *
 * @param value - The input value
 * @returns Sanitized value (converted to lowercase)
 *
 * @example
 * ```ts
 * <input
 *   value={address}
 *   onChange={(e) => setAddress(sanitizeBech32Input(e.target.value))}
 * />
 * ```
 */
export function sanitizeBech32Input(value: string): string {
  // Convert to lowercase (bech32 addresses are case-insensitive)
  const lowercased = value.toLowerCase()

  // Only allow: lowercase letters (a-z), digits (0-9), and separator '1'
  // Note: Bech32 base32 uses digits 2-7, but we allow 0-9 for HRP prefixes
  // The separator '1' is required in bech32 format
  return lowercased.replace(/[^a-z0-9]/g, '')
}

/**
 * Sanitizes EVM address input to only allow hexadecimal characters and '0x' prefix.
 *
 * @param value - The input value
 * @returns Sanitized value
 *
 * @example
 * ```ts
 * <input
 *   value={address}
 *   onChange={(e) => setAddress(sanitizeEvmAddressInput(e.target.value))}
 * />
 * ```
 */
export function sanitizeEvmAddressInput(value: string): string {
  // Convert to lowercase for consistency
  const lowercased = value.toLowerCase()

  // Check if it starts with '0x'
  const hasPrefix = lowercased.startsWith('0x')
  const withoutPrefix = hasPrefix ? lowercased.slice(2) : lowercased

  // Only allow hexadecimal characters (0-9, a-f)
  const sanitizedHex = withoutPrefix.replace(/[^0-9a-f]/g, '')

  // Limit to 40 hex characters (EVM address length)
  const limitedHex = sanitizedHex.slice(0, 40)

  // Reconstruct with prefix if it was there or if we have hex characters
  if (hasPrefix || lowercased.startsWith('0')) {
    return '0x' + limitedHex
  }

  return limitedHex
}

/**
 * Handler function for amount input onChange events.
 * Wraps sanitizeAmountInput for easy use in React components.
 *
 * @param e - React change event
 * @param setValue - State setter function
 * @param maxDecimals - Maximum decimal places (default: 6)
 */
export function handleAmountInputChange(
  e: React.ChangeEvent<HTMLInputElement>,
  setValue: (value: string) => void,
  maxDecimals: number = 6
): void {
  const sanitized = sanitizeAmountInput(e.target.value, maxDecimals)
  setValue(sanitized)
}

/**
 * Handler function for bech32 address input onChange events.
 * Wraps sanitizeBech32Input for easy use in React components.
 *
 * @param e - React change event
 * @param setValue - State setter function
 */
export function handleBech32InputChange(
  e: React.ChangeEvent<HTMLInputElement>,
  setValue: (value: string) => void
): void {
  const sanitized = sanitizeBech32Input(e.target.value)
  setValue(sanitized)
}

/**
 * Handler function for EVM address input onChange events.
 * Wraps sanitizeEvmAddressInput for easy use in React components.
 *
 * @param e - React change event
 * @param setValue - State setter function
 */
export function handleEvmAddressInputChange(
  e: React.ChangeEvent<HTMLInputElement>,
  setValue: (value: string) => void
): void {
  const sanitized = sanitizeEvmAddressInput(e.target.value)
  setValue(sanitized)
}

