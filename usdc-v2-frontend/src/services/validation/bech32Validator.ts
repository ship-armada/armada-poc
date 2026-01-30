/**
 * Bech32 address validator.
 * Uses the bech32 library to properly validate bech32-encoded addresses
 * with checksum verification and HRP validation.
 */

import { bech32, bech32m } from 'bech32'
import type { Bech32ValidationOptions, ValidationResult } from './types'
import { ValidationErrors, getErrorMessage } from './errors'

/**
 * Validates a bech32-encoded address.
 *
 * @param address - The address to validate
 * @param options - Validation options including expected HRP
 * @returns Validation result with isValid flag, error message, and normalized address
 *
 * @example
 * ```ts
 * const result = validateBech32Address('tnam1q...', { expectedHrp: 'tnam' })
 * if (result.isValid) {
 *   console.log('Valid address:', result.value)
 * }
 * ```
 */
export function validateBech32Address(
  address: string,
  options: Bech32ValidationOptions
): ValidationResult<string> {
  const {
    expectedHrp,
    normalize = true,
    errorMessages = {},
  } = options

  // Check for empty address
  if (!address || address.trim() === '') {
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.ADDRESS_BECH32_EMPTY,
        errorMessages.empty
      ),
    }
  }

  // Trim whitespace
  let trimmedAddress = address.trim()

  // Normalize to lowercase (bech32 addresses are case-insensitive)
  if (normalize) {
    trimmedAddress = trimmedAddress.toLowerCase()
  }

  // Attempt to decode the bech32 address
  // Try standard bech32 first (used by Noble), then bech32m (used by Namada)
  let decoded
  try {
    decoded = bech32.decode(trimmedAddress)
  } catch (bech32Error) {
    // If standard bech32 fails, try bech32m
  try {
    decoded = bech32m.decode(trimmedAddress)
    } catch (bech32mError) {
      // Both decodings failed - invalid bech32 encoding or checksum
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.ADDRESS_BECH32_DECODE_ERROR,
        errorMessages.invalidFormat || errorMessages.invalidChecksum
      ),
      }
    }
  }

  // Verify HRP matches expected value
  if (decoded.prefix !== expectedHrp) {
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.ADDRESS_BECH32_WRONG_HRP(expectedHrp, decoded.prefix),
        errorMessages.wrongHrp
      ),
    }
  }

  // If we got here, the address is valid
  // The bech32 library's decode() function validates the checksum automatically
  return {
    isValid: true,
    error: null,
    value: trimmedAddress, // Return normalized address
  }
}

/**
 * Convenience function to validate Namada addresses.
 * This is a wrapper around validateBech32Address with 'tnam' as the default HRP.
 *
 * @param address - The Namada address to validate
 * @param options - Optional validation options (defaults to HRP 'tnam')
 * @returns Validation result
 *
 * @example
 * ```ts
 * const result = validateNamadaAddress('tnam1q...')
 * ```
 */
export function validateNamadaAddress(
  address: string,
  options?: Omit<Bech32ValidationOptions, 'expectedHrp'>
): ValidationResult<string> {
  return validateBech32Address(address, {
    expectedHrp: 'tnam',
    ...options,
  })
}

