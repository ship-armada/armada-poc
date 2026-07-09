/**
 * Type definitions for the address book service.
 */

/**
 * Supported address types in the address book.
 */
export type AddressType = 'evm' | 'namada' | 'noble' | 'other'

/**
 * Address book entry interface.
 * Represents a single saved address with metadata.
 */
export interface AddressBookEntry {
  /** Unique identifier for the entry */
  id: string
  /** Human-readable name for the address */
  name: string
  /** The actual address (normalized/validated) */
  address: string
  /** Type of address */
  type: AddressType
  /** Timestamp when the entry was created */
  createdAt: number
  /** Timestamp when the entry was last updated */
  updatedAt: number
  /** Optional metadata (e.g., chain key, notes, tags) */
  metadata?: {
    chainKey?: string
    notes?: string
    tags?: string[]
    usageCount?: number // Track how many times this address was used
    lastUsedAt?: number // Timestamp of last usage
    [key: string]: unknown
  }
}

/**
 * Input for creating a new address book entry.
 */
export interface CreateAddressBookEntryInput {
  name: string
  address: string
  type?: AddressType // Optional, will be auto-detected if not provided
  metadata?: AddressBookEntry['metadata']
}

/**
 * Input for updating an existing address book entry.
 */
export interface UpdateAddressBookEntryInput {
  name?: string
  address?: string
  type?: AddressType
  metadata?: AddressBookEntry['metadata']
}

/**
 * Sort options for address book entries.
 */
export type AddressBookSortOption = 'name' | 'date' | 'type'

/**
 * Sort direction.
 */
export type SortDirection = 'asc' | 'desc'

/**
 * Filter options for address book.
 */
export interface AddressBookFilter {
  type?: AddressType | 'all'
  searchQuery?: string
  sortBy?: AddressBookSortOption
  sortDirection?: SortDirection
}

