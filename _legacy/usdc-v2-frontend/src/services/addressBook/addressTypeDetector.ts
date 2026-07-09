/**
 * Address type detection utility.
 * Automatically detects the type of an address based on its format.
 */

import { validateEvmAddress } from '../validation/evmAddressValidator'
import { validateBech32Address } from '../validation/bech32Validator'
import type { AddressType } from './types'

/**
 * Result of address type detection.
 */
export interface AddressTypeDetectionResult {
  type: AddressType | null
  isValid: boolean
  normalizedAddress?: string
  error?: string
}

/**
 * Detects the type of an address and validates it.
 * Returns the detected type, validation status, and normalized address.
 *
 * @param address - The address to detect and validate
 * @returns Detection result with type, validation status, and normalized address
 */
export function detectAddressType(address: string): AddressTypeDetectionResult {
  if (!address || address.trim() === '') {
    return {
      type: null,
      isValid: false,
      error: 'Address cannot be empty',
    }
  }

  const trimmed = address.trim()

  // Check for EVM address (starts with 0x)
  if (trimmed.startsWith('0x')) {
    const evmResult = validateEvmAddress(trimmed)
    if (evmResult.isValid && evmResult.value) {
      return {
        type: 'evm',
        isValid: true,
        normalizedAddress: evmResult.value,
      }
    }
    return {
      type: 'evm',
      isValid: false,
      error: evmResult.error || 'Invalid EVM address',
    }
  }

  // Check for Namada address (bech32 with 'tnam' HRP)
  const namadaResult = validateBech32Address(trimmed, { expectedHrp: 'tnam' })
  if (namadaResult.isValid && namadaResult.value) {
    return {
      type: 'namada',
      isValid: true,
      normalizedAddress: namadaResult.value,
    }
  }

  // Check for Noble address (bech32 with 'noble' HRP)
  const nobleResult = validateBech32Address(trimmed, { expectedHrp: 'noble' })
  if (nobleResult.isValid && nobleResult.value) {
    return {
      type: 'noble',
      isValid: true,
      normalizedAddress: nobleResult.value,
    }
  }

  // If it's a valid bech32 address but with unknown HRP, classify as 'other'
  // Try to decode without HRP validation
  try {
    const { bech32, bech32m } = require('bech32')
    try {
      bech32.decode(trimmed.toLowerCase())
      return {
        type: 'other',
        isValid: true,
        normalizedAddress: trimmed.toLowerCase(),
      }
    } catch {
      try {
        bech32m.decode(trimmed.toLowerCase())
        return {
          type: 'other',
          isValid: true,
          normalizedAddress: trimmed.toLowerCase(),
        }
      } catch {
        // Not a valid bech32 address
      }
    }
  } catch {
    // bech32 library not available or decode failed
  }

  // If we can't detect the type, return invalid
  return {
    type: null,
    isValid: false,
    error: 'Unable to detect address type. Please ensure the address is valid.',
  }
}

