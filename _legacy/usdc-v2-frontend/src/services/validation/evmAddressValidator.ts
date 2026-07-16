/**
 * EVM address validator.
 * Uses ethers.js to properly validate EVM addresses with checksum support.
 */

import { isAddress, getAddress } from 'ethers'
import type { EvmAddressValidationOptions, ValidationResult } from './types'
import { ValidationErrors, getErrorMessage } from './errors'

/**
 * Validates an EVM address.
 * Uses ethers.js isAddress() which validates format and checksum (EIP-55).
 *
 * @param address - The address to validate
 * @param options - Validation options
 * @returns Validation result with isValid flag, error message, and checksummed address
 *
 * @example
 * ```ts
 * const result = validateEvmAddress('0x1234...')
 * if (result.isValid) {
 *   console.log('Valid address:', result.value) // Checksummed address
 * }
 * ```
 */
export function validateEvmAddress(
  address: string,
  options: EvmAddressValidationOptions = {}
): ValidationResult<string> {
  const {
    checksum = true,
    normalize = true,
    errorMessages = {},
  } = options

  // Check for empty address
  if (!address || address.trim() === '') {
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.ADDRESS_EVM_EMPTY,
        errorMessages.empty
      ),
    }
  }

  // Trim whitespace
  const trimmedAddress: string = address.trim()

  // Validate using ethers.js isAddress()
  // This checks:
  // - Format: 0x prefix + 40 hex characters
  // - Checksum: EIP-55 checksum validation
  const isValidAddress = isAddress(trimmedAddress)
  if (!isValidAddress) {
    // Check if it's a format issue or checksum issue
    // Type assertion needed because isAddress type guard can cause incorrect narrowing
    const addressStr: string = trimmedAddress
    const withoutPrefix = addressStr.replace(/^0x/i, '')
    const isHex = /^[0-9a-fA-F]+$/.test(withoutPrefix)

    if (!addressStr.startsWith('0x')) {
      return {
        isValid: false,
        error: getErrorMessage(
          ValidationErrors.ADDRESS_EVM_INVALID_FORMAT,
          errorMessages.invalidFormat
        ),
      }
    }

    if (withoutPrefix.length !== 40) {
      return {
        isValid: false,
        error: getErrorMessage(
          ValidationErrors.ADDRESS_EVM_WRONG_LENGTH,
          errorMessages.invalidFormat
        ),
      }
    }

    if (!isHex) {
      return {
        isValid: false,
        error: getErrorMessage(
          ValidationErrors.ADDRESS_EVM_INVALID_FORMAT,
          errorMessages.invalidFormat
        ),
      }
    }

    // If format is correct but checksum is wrong
    if (checksum) {
      return {
        isValid: false,
        error: getErrorMessage(
          ValidationErrors.ADDRESS_EVM_INVALID_CHECKSUM,
          errorMessages.invalidChecksum || errorMessages.invalidFormat
        ),
      }
    }

    // If checksum validation is disabled, still reject invalid addresses
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.ADDRESS_EVM_INVALID_FORMAT,
        errorMessages.invalidFormat
      ),
    }
  }

  // Address is valid
  // Normalize to checksummed format using getAddress()
  // getAddress() returns the checksummed version of the address
  const normalizedAddress = checksum && normalize
    ? getAddress(trimmedAddress)
    : trimmedAddress

  return {
    isValid: true,
    error: null,
    value: normalizedAddress,
  }
}

