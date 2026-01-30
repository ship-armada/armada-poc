/**
 * Core types for the validation service.
 * Provides type-safe interfaces for all validation results and options.
 */

/**
 * Generic validation result interface.
 * @template T - The type of the validated value (usually string for addresses/amounts)
 */
export interface ValidationResult<T = string> {
  /** Whether the validation passed */
  isValid: boolean
  /** Error message if validation failed, null if valid */
  error: string | null
  /** The validated/normalized value (only present if valid) */
  value?: T
}

/**
 * Options for amount validation.
 */
export interface AmountValidationOptions {
  /** Maximum number of decimal places allowed (default: 6 for USDC) */
  maxDecimals?: number
  /** Minimum amount allowed (default: 0) */
  minAmount?: number | string
  /** Maximum amount allowed (e.g., available balance) */
  maxAmount?: number | string
  /** Estimated fee to add to amount when checking against maxAmount */
  estimatedFee?: number | string
  /** Fee amount for checking if amount is less than fee (when fee is in same token) */
  feeAmount?: number | string
  /** Fee token symbol (e.g., 'USDC', 'NAM') - used to determine if fee check applies */
  feeToken?: string
  /** Amount token symbol (e.g., 'USDC') - used to compare with feeToken */
  amountToken?: string
  /** Whether to allow scientific notation (default: false) */
  allowScientificNotation?: boolean
  /** Custom error messages */
  errorMessages?: {
    empty?: string
    invalidFormat?: string
    notPositive?: string
    tooManyDecimals?: string
    belowMinimum?: string
    exceedsMaximum?: string
    insufficientBalance?: string
    lessThanFee?: string
  }
}

/**
 * Options for bech32 address validation.
 */
export interface Bech32ValidationOptions {
  /** Expected Human-Readable Part (HRP), e.g., 'tnam' for Namada testnet */
  expectedHrp: string
  /** Whether to normalize the address to lowercase (default: true) */
  normalize?: boolean
  /** Custom error messages */
  errorMessages?: {
    empty?: string
    invalidFormat?: string
    wrongHrp?: string
    invalidChecksum?: string
  }
}

/**
 * Options for EVM address validation.
 */
export interface EvmAddressValidationOptions {
  /** Whether to return checksummed address (default: true) */
  checksum?: boolean
  /** Whether to normalize the address (default: true) */
  normalize?: boolean
  /** Custom error messages */
  errorMessages?: {
    empty?: string
    invalidFormat?: string
    invalidChecksum?: string
  }
}

/**
 * Combined form validation result for forms with multiple fields.
 */
export interface FormValidationResult {
  /** Whether all fields are valid */
  isValid: boolean
  /** Field-specific error messages */
  errors: Record<string, string | null>
}

/**
 * Legacy interfaces for backward compatibility during migration.
 * These match the existing validation interfaces.
 */
export interface AmountValidation {
  isValid: boolean
  error: string | null
}

export interface AddressValidation {
  isValid: boolean
  error: string | null
}

export interface DepositFormValidation {
  isValid: boolean
  amountError: string | null
  addressError: string | null
}

export interface PaymentFormValidation {
  isValid: boolean
  amountError: string | null
  addressError: string | null
}

