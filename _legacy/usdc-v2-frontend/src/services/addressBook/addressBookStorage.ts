/**
 * Address book storage service.
 * Handles persistence of address book entries to localStorage.
 */

import { saveItem, loadItem, deleteItem } from '../storage/localStore'
import type { AddressBookEntry } from './types'

const STORAGE_KEY = 'address-book'

/**
 * Load all address book entries from localStorage.
 */
export function loadAddressBook(): AddressBookEntry[] {
  const stored = loadItem<AddressBookEntry[]>(STORAGE_KEY)
  return stored ?? []
}

/**
 * Save address book entries to localStorage.
 */
export function saveAddressBook(entries: AddressBookEntry[]): void {
  saveItem(STORAGE_KEY, entries)
}

/**
 * Clear all address book entries from localStorage.
 */
export function clearAddressBook(): void {
  deleteItem(STORAGE_KEY)
}

