/**
 * Unified validation service.
 * Main entry point for all validation functions.
 *
 * @example
 * ```ts
 * import { validateAmount, validateNamadaAddress, validateEvmAddress } from '@/services/validation'
 *
 * // Validate amount
 * const amountResult = validateAmount('10.50', {
 *   maxDecimals: 6,
 *   maxAmount: '100.00',
 *   estimatedFee: '0.12'
 * })
 *
 * // Validate Namada address
 * const namadaResult = validateNamadaAddress('tnam1q...')
 *
 * // Validate EVM address
 * const evmResult = validateEvmAddress('0x1234...')
 * ```
 */

// Export types
export type {
  ValidationResult,
  AmountValidationOptions,
  Bech32ValidationOptions,
  EvmAddressValidationOptions,
  FormValidationResult,
  // Legacy types for backward compatibility
  AmountValidation,
  AddressValidation,
  DepositFormValidation,
  PaymentFormValidation,
} from './types'

// Export validators
export { validateAmount } from './amountValidator'
export { validateBech32Address, validateNamadaAddress } from './bech32Validator'
export { validateEvmAddress } from './evmAddressValidator'

// Export error messages
export { ValidationErrors } from './errors'

// Export input guards
export {
  sanitizeAmountInput,
  sanitizeBech32Input,
  sanitizeEvmAddressInput,
  handleAmountInputChange,
  handleBech32InputChange,
  handleEvmAddressInputChange,
} from './inputGuards'

// Convenience functions for common use cases

import { validateAmount } from './amountValidator'
import { validateNamadaAddress } from './bech32Validator'
import { validateEvmAddress } from './evmAddressValidator'
import type {
  AmountValidationOptions,
  DepositFormValidation,
  PaymentFormValidation,
} from './types'

/**
 * Validates a deposit form (amount + Namada address).
 * Combines amount and address validation results.
 *
 * @param amount - The amount to validate
 * @param availableBalance - The available EVM balance
 * @param estimatedFee - The estimated fee for the transaction
 * @param address - The destination Namada address
 * @param options - Optional amount validation options
 * @returns Combined validation result
 */
export function validateDepositForm(
  amount: string,
  availableBalance: string,
  estimatedFee: string,
  address: string,
  options?: Omit<AmountValidationOptions, 'maxAmount' | 'estimatedFee'>
): DepositFormValidation {
  const amountOptions: AmountValidationOptions = {
    maxDecimals: 6,
    maxAmount: availableBalance,
    estimatedFee,
    ...options,
  }

  const amountValidation = validateAmount(amount, amountOptions)
  const addressValidation = validateNamadaAddress(address)

  return {
    isValid: amountValidation.isValid && addressValidation.isValid,
    amountError: amountValidation.error,
    addressError: addressValidation.error,
  }
}

/**
 * Validates a payment form (amount + EVM address).
 * Combines amount and address validation results.
 *
 * @param amount - The amount to validate
 * @param availableBalance - The available shielded balance
 * @param estimatedFee - The estimated fee for the transaction
 * @param address - The destination EVM address
 * @param options - Optional amount validation options
 * @returns Combined validation result
 */
export function validatePaymentForm(
  amount: string,
  availableBalance: string,
  estimatedFee: string,
  address: string,
  options?: Omit<AmountValidationOptions, 'maxAmount' | 'estimatedFee'>
): PaymentFormValidation {
  const amountOptions: AmountValidationOptions = {
    maxDecimals: 6,
    maxAmount: availableBalance,
    estimatedFee,
    ...options,
  }

  const amountValidation = validateAmount(amount, amountOptions)
  const addressValidation = validateEvmAddress(address)

  return {
    isValid: amountValidation.isValid && addressValidation.isValid,
    amountError: amountValidation.error,
    addressError: addressValidation.error,
  }
}

/**
 * Validates an amount for shielding operations.
 * Similar to validateAmount but with defaults for shielding.
 *
 * @param amount - The amount to validate
 * @param availableBalance - The available transparent balance
 * @param options - Optional amount validation options (can include feeAmount, feeToken, amountToken)
 * @returns Validation result
 */
export function validateShieldAmount(
  amount: string,
  availableBalance: string,
  options?: Omit<AmountValidationOptions, 'maxAmount'>
): ReturnType<typeof validateAmount> {
  const amountOptions: AmountValidationOptions = {
    maxDecimals: 6,
    maxAmount: availableBalance,
    amountToken: 'USDC', // Shield amount is always USDC
    ...options,
  }

  return validateAmount(amount, amountOptions)
}

