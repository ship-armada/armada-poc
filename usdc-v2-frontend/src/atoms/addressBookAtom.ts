/**
 * Address book state management using Jotai atoms.
 */

import { atom } from 'jotai'
import type { AddressBookEntry, AddressType, AddressBookFilter } from '@/services/addressBook/types'
import { getAllAddresses } from '@/services/addressBook/addressBookService'

/**
 * Atom storing all address book entries.
 * Initialized from localStorage on first access.
 */
export const addressBookAtom = atom<AddressBookEntry[]>(getAllAddresses())

/**
 * Atom for filtering address book entries.
 */
export const addressBookFilterAtom = atom<AddressBookFilter>({
  type: 'all',
  searchQuery: '',
  sortBy: 'name',
  sortDirection: 'asc',
})

/**
 * Derived atom for filtered and sorted addresses.
 */
export const filteredAddressBookAtom = atom((get) => {
  const entries = get(addressBookAtom)
  const filter = get(addressBookFilterAtom)

  let filtered = [...entries]

  // Filter by type
  if (filter.type && filter.type !== 'all') {
    filtered = filtered.filter((entry) => entry.type === filter.type)
  }

  // Filter by search query
  if (filter.searchQuery && filter.searchQuery.trim() !== '') {
    const query = filter.searchQuery.toLowerCase().trim()
    filtered = filtered.filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) ||
        entry.address.toLowerCase().includes(query) ||
        entry.metadata?.notes?.toLowerCase().includes(query)
    )
  }

  // Sort entries
  const sortBy = filter.sortBy ?? 'name'
  const sortDirection = filter.sortDirection ?? 'asc'

  filtered.sort((a, b) => {
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

  return filtered
})

/**
 * Atom for address book statistics.
 */
export const addressBookStatsAtom = atom((get) => {
  const entries = get(addressBookAtom)
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
})

