/**
 * Address book service.
 * Core service for managing address book entries with CRUD operations.
 */

import { loadAddressBook, saveAddressBook } from './addressBookStorage'
import { detectAddressType } from './addressTypeDetector'
import type {
  AddressBookEntry,
  AddressType,
  CreateAddressBookEntryInput,
  UpdateAddressBookEntryInput,
  AddressBookFilter,
} from './types'

/**
 * Get all address book entries.
 */
export function getAllAddresses(): AddressBookEntry[] {
  return loadAddressBook()
}

/**
 * Get a single address book entry by ID.
 */
export function getAddress(id: string): AddressBookEntry | null {
  const entries = loadAddressBook()
  return entries.find((entry) => entry.id === id) ?? null
}

/**
 * Get addresses filtered by type.
 */
export function getAddressesByType(type: AddressType): AddressBookEntry[] {
  const entries = loadAddressBook()
  return entries.filter((entry) => entry.type === type)
}

/**
 * Search addresses by name or address.
 */
export function searchAddresses(query: string): AddressBookEntry[] {
  if (!query || query.trim() === '') {
    return getAllAddresses()
  }

  const searchLower = query.toLowerCase().trim()
  const entries = loadAddressBook()

  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(searchLower) ||
      entry.address.toLowerCase().includes(searchLower) ||
      entry.metadata?.notes?.toLowerCase().includes(searchLower)
  )
}

/**
 * Filter and sort addresses based on filter options.
 */
export function filterAddresses(filter: AddressBookFilter): AddressBookEntry[] {
  let entries = loadAddressBook()

  // Filter by type
  if (filter.type && filter.type !== 'all') {
    entries = entries.filter((entry) => entry.type === filter.type)
  }

  // Filter by search query
  if (filter.searchQuery && filter.searchQuery.trim() !== '') {
    entries = searchAddresses(filter.searchQuery)
    // Re-apply type filter if needed
    if (filter.type && filter.type !== 'all') {
      entries = entries.filter((entry) => entry.type === filter.type)
    }
  }

  // Sort entries
  const sortBy = filter.sortBy ?? 'name'
  const sortDirection = filter.sortDirection ?? 'asc'

  entries.sort((a, b) => {
    let comparison = 0

    switch (sortBy) {
      case 'name':
        comparison = a.name.localeCompare(b.name)
        break
      case 'date':
        comparison = a.createdAt - b.createdAt
        break
      case 'type':
        comparison = a.type.localeCompare(b.type)
        break
      default:
        comparison = 0
    }

    return sortDirection === 'asc' ? comparison : -comparison
  })

  return entries
}

/**
 * Add a new address to the address book.
 * Validates and normalizes the address before saving.
 */
export function addAddress(
  input: CreateAddressBookEntryInput
): { success: true; entry: AddressBookEntry } | { success: false; error: string } {
  // Validate name
  if (!input.name || input.name.trim() === '') {
    return { success: false, error: 'Name is required' }
  }

  // Detect and validate address type
  const detection = detectAddressType(input.address)
  if (!detection.isValid || !detection.normalizedAddress) {
    return {
      success: false,
      error: detection.error || 'Invalid address format',
    }
  }

  // Use detected type or provided type
  const addressType: AddressType = input.type ?? detection.type ?? 'other'

  // Check for duplicate addresses
  const existingEntries = loadAddressBook()
  const normalizedAddress = detection.normalizedAddress
  const duplicate = existingEntries.find(
    (entry) => entry.address.toLowerCase() === normalizedAddress.toLowerCase()
  )

  if (duplicate) {
    return {
      success: false,
      error: `Address already exists in address book as "${duplicate.name}"`,
    }
  }

  // Create new entry
  const now = Date.now()
  const entry: AddressBookEntry = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    address: normalizedAddress,
    type: addressType,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata,
  }

  // Save to storage
  const entries = [...existingEntries, entry]
  saveAddressBook(entries)

  return { success: true, entry }
}

/**
 * Update an existing address book entry.
 */
export function updateAddress(
  id: string,
  input: UpdateAddressBookEntryInput
): { success: true; entry: AddressBookEntry } | { success: false; error: string } {
  const entries = loadAddressBook()
  const index = entries.findIndex((entry) => entry.id === id)

  if (index === -1) {
    return { success: false, error: 'Address not found' }
  }

  const existingEntry = entries[index]
  const updates: Partial<AddressBookEntry> = {
    updatedAt: Date.now(),
  }

  // Update name if provided
  if (input.name !== undefined) {
    if (input.name.trim() === '') {
      return { success: false, error: 'Name cannot be empty' }
    }
    updates.name = input.name.trim()
  }

  // Update address if provided
  if (input.address !== undefined) {
    const detection = detectAddressType(input.address)
    if (!detection.isValid || !detection.normalizedAddress) {
      return {
        success: false,
        error: detection.error || 'Invalid address format',
      }
    }

    // Check for duplicate addresses (excluding current entry)
    const normalizedAddress = detection.normalizedAddress
    const duplicate = entries.find(
      (entry) =>
        entry.id !== id &&
        entry.address.toLowerCase() === normalizedAddress.toLowerCase()
    )

    if (duplicate) {
      return {
        success: false,
        error: `Address already exists in address book as "${duplicate.name}"`,
      }
    }

    updates.address = normalizedAddress
    updates.type = input.type ?? detection.type ?? existingEntry.type
  }

  // Update type if provided (and address wasn't updated)
  if (input.type !== undefined && input.address === undefined) {
    updates.type = input.type
  }

  // Update metadata if provided
  if (input.metadata !== undefined) {
    updates.metadata = { ...existingEntry.metadata, ...input.metadata }
  }

  // Create updated entry
  const updatedEntry: AddressBookEntry = {
    ...existingEntry,
    ...updates,
  }

  // Save to storage
  entries[index] = updatedEntry
  saveAddressBook(entries)

  return { success: true, entry: updatedEntry }
}

/**
 * Delete an address from the address book.
 */
export function deleteAddress(id: string): { success: true } | { success: false; error: string } {
  const entries = loadAddressBook()
  const filtered = entries.filter((entry) => entry.id !== id)

  if (filtered.length === entries.length) {
    return { success: false, error: 'Address not found' }
  }

  saveAddressBook(filtered)
  return { success: true }
}

/**
 * Check if an address already exists in the address book.
 */
export function addressExists(address: string): boolean {
  const entries = loadAddressBook()
  const normalized = address.toLowerCase().trim()
  return entries.some((entry) => entry.address.toLowerCase() === normalized)
}

/**
 * Get address book statistics.
 */
export function getAddressBookStats(): {
  total: number
  byType: Record<AddressType, number>
} {
  const entries = loadAddressBook()
  const stats = {
    total: entries.length,
    byType: {
      evm: 0,
      namada: 0,
      noble: 0,
      other: 0,
    } as Record<AddressType, number>,
  }

  entries.forEach((entry) => {
    stats.byType[entry.type] = (stats.byType[entry.type] ?? 0) + 1
  })

  return stats
}

/**
 * Increment usage count for an address.
 */
export function incrementAddressUsage(id: string): void {
  const entries = loadAddressBook()
  const index = entries.findIndex((entry) => entry.id === id)
  if (index !== -1) {
    entries[index] = {
      ...entries[index],
      metadata: {
        ...entries[index].metadata,
        usageCount: (entries[index].metadata?.usageCount ?? 0) + 1,
        lastUsedAt: Date.now(),
      },
      updatedAt: Date.now(),
    }
    saveAddressBook(entries)
  }
}

/**
 * Export address book entries as JSON.
 */
export function exportAddressBook(): string {
  const entries = loadAddressBook()
  return JSON.stringify(entries, null, 2)
}

/**
 * Import address book entries from JSON.
 * Returns success status and any errors.
 */
export function importAddressBook(
  jsonData: string
): { success: true; imported: number } | { success: false; error: string } {
  try {
    const parsed = JSON.parse(jsonData)
    if (!Array.isArray(parsed)) {
      return { success: false, error: 'Invalid format: expected an array of addresses' }
    }

    // Validate entries
    const validEntries: AddressBookEntry[] = []
    for (const entry of parsed) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.id === 'string' &&
        typeof entry.name === 'string' &&
        typeof entry.address === 'string' &&
        typeof entry.type === 'string' &&
        typeof entry.createdAt === 'number'
      ) {
        // Validate address type
        const detection = detectAddressType(entry.address)
        if (detection.isValid && detection.normalizedAddress) {
          validEntries.push({
            ...entry,
            address: detection.normalizedAddress,
            type: (entry.type as AddressType) || detection.type || 'other',
            updatedAt: entry.updatedAt || entry.createdAt,
          })
        }
      }
    }

    if (validEntries.length === 0) {
      return { success: false, error: 'No valid addresses found in import data' }
    }

    // Merge with existing entries (avoid duplicates by address)
    const existing = loadAddressBook()
    const existingAddresses = new Set(existing.map((e) => e.address.toLowerCase()))
    const newEntries = validEntries.filter(
      (e) => !existingAddresses.has(e.address.toLowerCase())
    )

    if (newEntries.length === 0) {
      return { success: false, error: 'All addresses already exist in address book' }
    }

    // Add new entries
    const merged = [...existing, ...newEntries]
    saveAddressBook(merged)

    return { success: true, imported: newEntries.length }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to parse JSON data',
    }
  }
}

