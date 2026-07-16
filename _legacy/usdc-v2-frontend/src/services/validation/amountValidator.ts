/**
 * Amount validator.
 * Validates numeric amounts with decimal precision, balance checks, and edge case handling.
 */

import type { AmountValidationOptions, ValidationResult } from './types'
import { ValidationErrors, getErrorMessage } from './errors'

/**
 * Validates a numeric amount string.
 *
 * @param amount - The amount to validate (as string)
 * @param options - Validation options
 * @returns Validation result with isValid flag, error message, and normalized amount
 *
 * @example
 * ```ts
 * const result = validateAmount('10.50', {
 *   maxDecimals: 6,
 *   maxAmount: '100.00',
 *   estimatedFee: '0.12'
 * })
 * ```
 */
export function validateAmount(
  amount: string,
  options: AmountValidationOptions = {}
): ValidationResult<string> {
  const {
    maxDecimals = 6,
    minAmount,
    maxAmount,
    estimatedFee,
    feeAmount,
    feeToken,
    amountToken,
    allowScientificNotation = false,
    errorMessages = {},
  } = options

  // Check for empty amount
  if (!amount || amount.trim() === '') {
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.AMOUNT_EMPTY,
        errorMessages.empty
      ),
    }
  }

  // Trim whitespace
  const trimmedAmount = amount.trim()

  // Check for scientific notation (reject unless explicitly allowed)
  if (!allowScientificNotation && /[eE]/.test(trimmedAmount)) {
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.AMOUNT_SCIENTIFIC_NOTATION,
        errorMessages.invalidFormat
      ),
    }
  }

  // Check for multiple decimal points
  const decimalPointCount = (trimmedAmount.match(/\./g) || []).length
  if (decimalPointCount > 1) {
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.AMOUNT_INVALID_FORMAT,
        errorMessages.invalidFormat
      ),
    }
  }

  // Parse numeric value
  const numAmount = parseFloat(trimmedAmount)

  // Check if amount is a valid number
  if (isNaN(numAmount)) {
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.AMOUNT_INVALID_FORMAT,
        errorMessages.invalidFormat
      ),
    }
  }

  // Check if amount is positive
  if (numAmount <= 0) {
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.AMOUNT_NOT_POSITIVE,
        errorMessages.notPositive
      ),
    }
  }

  // Check decimal precision
  const decimalPart = trimmedAmount.includes('.')
    ? trimmedAmount.split('.')[1]
    : ''
  if (decimalPart.length > maxDecimals) {
    return {
      isValid: false,
      error: getErrorMessage(
        ValidationErrors.AMOUNT_TOO_MANY_DECIMALS(maxDecimals),
        errorMessages.tooManyDecimals
      ),
    }
  }

  // Check minimum amount
  if (minAmount !== undefined) {
    const minNum = typeof minAmount === 'string' ? parseFloat(minAmount) : minAmount
    if (!isNaN(minNum) && numAmount < minNum) {
      return {
        isValid: false,
        error: getErrorMessage(
          ValidationErrors.AMOUNT_BELOW_MINIMUM(
            typeof minAmount === 'string' ? minAmount : minAmount.toFixed(maxDecimals)
          ),
          errorMessages.belowMinimum
        ),
      }
    }
  }

  // Check if amount is less than or equal to fee (only when fee is in the same token as amount)
  // This ensures the user can shield a meaningful amount after fees are deducted
  if (feeAmount !== undefined && feeToken && amountToken && feeToken === amountToken) {
    const feeNum = typeof feeAmount === 'string' ? parseFloat(feeAmount) : feeAmount
    if (!isNaN(feeNum) && feeNum > 0 && numAmount <= feeNum) {
      return {
        isValid: false,
        error: getErrorMessage(
          ValidationErrors.AMOUNT_LESS_THAN_FEE(
            feeNum.toFixed(maxDecimals),
            feeToken
          ),
          errorMessages.lessThanFee
        ),
      }
    }
  }

  // Check maximum amount (with optional fee)
  if (maxAmount !== undefined) {
    const maxNum = typeof maxAmount === 'string' ? parseFloat(maxAmount) : maxAmount
    const feeNum = estimatedFee !== undefined
      ? (typeof estimatedFee === 'string' ? parseFloat(estimatedFee) : estimatedFee)
      : 0

    // Validate maxAmount and fee are valid numbers
    if (isNaN(maxNum) || maxNum < 0) {
      return {
        isValid: false,
        error: getErrorMessage(
          ValidationErrors.INVALID_BALANCE,
          errorMessages.exceedsMaximum
        ),
      }
    }

    if (isNaN(feeNum) || feeNum < 0) {
      return {
        isValid: false,
        error: getErrorMessage(
          ValidationErrors.INVALID_FEE,
          errorMessages.exceedsMaximum
        ),
      }
    }

    // Check if amount + fee exceeds maximum
    const totalRequired = numAmount + feeNum
    if (totalRequired > maxNum) {
      const availableAfterFee = maxNum - feeNum
      if (availableAfterFee <= 0) {
        return {
          isValid: false,
          error: getErrorMessage(
            ValidationErrors.AMOUNT_INSUFFICIENT_BALANCE,
            errorMessages.insufficientBalance
          ),
        }
      }
      return {
        isValid: false,
        error: getErrorMessage(
          ValidationErrors.AMOUNT_EXCEEDS_BALANCE(
            availableAfterFee.toFixed(maxDecimals)
          ),
          errorMessages.exceedsMaximum
        ),
      }
    }
  }

  // Normalize amount: remove trailing zeros from decimal part
  // e.g., "10.00" -> "10", "10.50" -> "10.5"
  let normalizedAmount = trimmedAmount
  if (normalizedAmount.includes('.')) {
    normalizedAmount = normalizedAmount.replace(/\.?0+$/, '')
    // Handle case where only decimal point remains (e.g., "10." -> "10")
    if (normalizedAmount.endsWith('.')) {
      normalizedAmount = normalizedAmount.slice(0, -1)
    }
  }

  return {
    isValid: true,
    error: null,
    value: normalizedAmount,
  }
}

