/**
 * Standardized error messages for validation.
 * Provides consistent error messages across all validators.
 */

export const ValidationErrors = {
  // Amount validation errors
  AMOUNT_EMPTY: 'Please enter an amount',
  AMOUNT_INVALID_FORMAT: 'Please enter a valid amount',
  AMOUNT_NOT_POSITIVE: 'Amount must be greater than zero',
  AMOUNT_TOO_MANY_DECIMALS: (maxDecimals: number) =>
    `Amount cannot have more than ${maxDecimals} decimal places`,
  AMOUNT_BELOW_MINIMUM: (minAmount: string) =>
    `Amount must be at least ${minAmount}`,
  AMOUNT_EXCEEDS_MAXIMUM: (maxAmount: string) =>
    `Amount exceeds maximum. Maximum: ${maxAmount}`,
  AMOUNT_INSUFFICIENT_BALANCE: 'Insufficient balance to cover fees',
  AMOUNT_EXCEEDS_BALANCE: (availableAfterFee: string) =>
    `Amount + fees exceeds available balance. Maximum send amount after fees: ${availableAfterFee}`,
  AMOUNT_LESS_THAN_FEE: (feeAmount: string, feeToken: string) =>
    `Amount must be greater than the Noble forwarding registration fee (${feeAmount} ${feeToken})`,
  AMOUNT_SCIENTIFIC_NOTATION: 'Scientific notation is not allowed. Please enter a decimal number',

  // Bech32 address validation errors
  ADDRESS_BECH32_EMPTY: 'Please enter an address',
  ADDRESS_BECH32_INVALID_FORMAT: 'Invalid address format',
  ADDRESS_BECH32_WRONG_HRP: (expected: string, received: string) =>
    `Invalid address format. Expected address starting with "${expected}", but received "${received}"`,
  ADDRESS_BECH32_INVALID_CHECKSUM: 'Invalid address checksum',
  ADDRESS_BECH32_DECODE_ERROR: 'Invalid bech32 encoding',

  // EVM address validation errors
  ADDRESS_EVM_EMPTY: 'Please enter a destination address',
  ADDRESS_EVM_INVALID_FORMAT: 'Invalid EVM address format. Expected: 0x followed by 40 hexadecimal characters',
  ADDRESS_EVM_INVALID_CHECKSUM: 'Invalid address checksum',
  ADDRESS_EVM_WRONG_LENGTH: 'Invalid address length. EVM addresses must be 42 characters (0x + 40 hex chars)',

  // Namada-specific convenience errors
  ADDRESS_NAMADA_EMPTY: 'Please enter a Namada address',
  ADDRESS_NAMADA_INVALID: 'Invalid Namada address format',

  // Generic errors
  INVALID_BALANCE: 'Invalid available balance',
  INVALID_FEE: 'Invalid fee estimation',
} as const

/**
 * Helper function to get error message with optional custom override.
 */
export function getErrorMessage(
  defaultMessage: string | ((...args: any[]) => string),
  customMessage?: string,
  ...args: any[]
): string {
  if (customMessage) {
    return customMessage
  }
  if (typeof defaultMessage === 'function') {
    return defaultMessage(...args)
  }
  return defaultMessage
}

