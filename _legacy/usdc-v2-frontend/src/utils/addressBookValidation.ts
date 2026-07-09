/**
 * Address book validation utilities.
 * Provides reusable validation functions for address book operations.
 */

import { getAllAddresses, addressExists } from '@/services/addressBook/addressBookService'
import type { AddressBookEntry } from '@/services/addressBook/types'

export interface ValidationResult {
  isValid: boolean
  error: string | null
}

/**
 * Validation constraints for address book fields.
 */
export const ADDRESS_BOOK_CONSTRAINTS = {
  NAME: {
    MAX_LENGTH: 24,
    MIN_LENGTH: 1,
    PATTERN: /^[a-zA-Z0-9\s]+$/, // Alphanumeric and spaces
  },
  MEMO: {
    MAX_LENGTH: 200,
    PATTERN: /^[a-zA-Z0-9\s]+$/, // Alphanumeric and spaces
  },
} as const

/**
 * Validates an address book name.
 * Checks if name is provided, not empty, length constraints, alphanumeric pattern, and unique.
 *
 * @param name - The name to validate
 * @param address - The address associated with the name (for context)
 * @param excludeId - Optional entry ID to exclude from uniqueness check (for edits)
 * @returns Validation result with isValid flag and error message
 */
export function validateAddressBookName(
  name: string,
  address: string,
  excludeId?: string
): ValidationResult {
  // Check if name is provided
  if (!name || name.trim() === '') {
    return {
      isValid: false,
      error: 'Name is required',
    }
  }

  const trimmedName = name.trim()

  // Check length constraints
  if (trimmedName.length > ADDRESS_BOOK_CONSTRAINTS.NAME.MAX_LENGTH) {
    return {
      isValid: false,
      error: `Name must be ${ADDRESS_BOOK_CONSTRAINTS.NAME.MAX_LENGTH} characters or less`,
    }
  }

  if (trimmedName.length < ADDRESS_BOOK_CONSTRAINTS.NAME.MIN_LENGTH) {
    return {
      isValid: false,
      error: 'Name is required',
    }
  }

  // Check alphanumeric pattern
  if (!ADDRESS_BOOK_CONSTRAINTS.NAME.PATTERN.test(trimmedName)) {
    return {
      isValid: false,
      error: 'Name can only contain letters, numbers, and spaces',
    }
  }

  // Check if address is valid (must not be empty)
  if (!address || address.trim() === '') {
    return {
      isValid: false,
      error: 'Please enter a valid address first',
    }
  }

  // Check if address already exists in address book (excluding current entry in edit mode)
  const existingEntries = getAllAddresses()
  const normalizedAddress = address.toLowerCase().trim()
  const duplicateAddress = existingEntries.find(
    (entry) =>
      entry.address.toLowerCase() === normalizedAddress &&
      (!excludeId || entry.id !== excludeId)
  )

  if (duplicateAddress) {
    return {
      isValid: false,
      error: 'Address already exists in address book',
    }
  }

  // Check if name is unique (reuse existingEntries from address check above)
  const duplicateName = existingEntries.find(
    (entry) =>
      entry.name.toLowerCase() === trimmedName.toLowerCase() &&
      (!excludeId || entry.id !== excludeId)
  )

  if (duplicateName) {
    return {
      isValid: false,
      error: `Name "${duplicateName.name}" already exists in address book`,
    }
  }

  return {
    isValid: true,
    error: null,
  }
}

/**
 * Checks if a name is unique in the address book.
 *
 * @param name - The name to check
 * @param excludeId - Optional entry ID to exclude from check (for edits)
 * @returns True if name is unique, false otherwise
 */
export function checkNameUniqueness(name: string, excludeId?: string): boolean {
  const existingEntries = getAllAddresses()
  const duplicate = existingEntries.find(
    (entry) =>
      entry.name.toLowerCase() === name.trim().toLowerCase() &&
      (!excludeId || entry.id !== excludeId)
  )
  return !duplicate
}

/**
 * Checks if an address exists in the address book.
 * This is a wrapper around the service function for consistency.
 *
 * @param address - The address to check
 * @returns True if address exists, false otherwise
 */
export function checkAddressExists(address: string): boolean {
  return addressExists(address)
}

/**
 * Validates an address book memo/notes field.
 * Memo is optional, but if provided must meet length and character constraints.
 *
 * @param memo - The memo to validate
 * @returns Validation result with isValid flag and error message
 */
export function validateAddressBookMemo(memo: string): ValidationResult {
  // Memo is optional, so empty is valid
  if (!memo || memo.trim() === '') {
    return {
      isValid: true,
      error: null,
    }
  }

  const trimmedMemo = memo.trim()

  // Check length constraint
  if (trimmedMemo.length > ADDRESS_BOOK_CONSTRAINTS.MEMO.MAX_LENGTH) {
    return {
      isValid: false,
      error: `Memo must be ${ADDRESS_BOOK_CONSTRAINTS.MEMO.MAX_LENGTH} characters or less`,
    }
  }

  // Check alphanumeric pattern
  if (!ADDRESS_BOOK_CONSTRAINTS.MEMO.PATTERN.test(trimmedMemo)) {
    return {
      isValid: false,
      error: 'Memo can only contain letters, numbers, and spaces',
    }
  }

  return {
    isValid: true,
    error: null,
  }
}

/**
 * Finds an address book entry by address.
 *
 * @param address - The address to search for
 * @returns The address book entry if found, null otherwise
 */
export function findAddressBookEntry(address: string): AddressBookEntry | null {
  const entries = getAllAddresses()
  return (
    entries.find((entry) => entry.address.toLowerCase() === address.toLowerCase().trim()) ?? null
  )
}

