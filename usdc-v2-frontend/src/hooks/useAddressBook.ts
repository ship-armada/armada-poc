/**
 * React hook for managing address book entries.
 * Provides convenient access to address book operations and state.
 */

import { useAtom, useAtomValue } from 'jotai'
import { useCallback } from 'react'
import {
  addressBookAtom,
  addressBookFilterAtom,
  filteredAddressBookAtom,
  addressBookStatsAtom,
} from '@/atoms/addressBookAtom'
import {
  addAddress as addAddressService,
  updateAddress as updateAddressService,
  deleteAddress as deleteAddressService,
  getAddressesByType,
  searchAddresses,
  addressExists,
  getAllAddresses,
  incrementAddressUsage,
  exportAddressBook,
  importAddressBook,
} from '@/services/addressBook/addressBookService'
import type { AddressType, AddressBookFilter, CreateAddressBookEntryInput, UpdateAddressBookEntryInput } from '@/services/addressBook/types'
import { useToast } from './useToast'

/**
 * Hook for managing address book.
 * Provides state, operations, and helper functions.
 */
export function useAddressBook() {
  const [entries, setEntries] = useAtom(addressBookAtom)
  const [filter, setFilter] = useAtom(addressBookFilterAtom)
  const filteredEntries = useAtomValue(filteredAddressBookAtom)
  const stats = useAtomValue(addressBookStatsAtom)
  const { notify } = useToast()

  /**
   * Refresh entries from storage.
   */
  const refreshEntries = useCallback(() => {
    const stored = getAllAddresses()
    setEntries(stored)
  }, [setEntries])

  /**
   * Add a new address to the address book.
   */
  const addAddress = useCallback(
    (input: CreateAddressBookEntryInput) => {
      const result = addAddressService(input)
      if (result.success) {
        refreshEntries()
        notify({
          level: 'success',
          title: 'Address added',
          description: `"${result.entry.name}" has been added to your address book.`,
        })
        return result.entry
      } else {
        notify({
          level: 'error',
          title: 'Failed to add address',
          description: result.error,
        })
        throw new Error(result.error)
      }
    },
    [refreshEntries, notify]
  )

  /**
   * Update an existing address.
   */
  const updateAddress = useCallback(
    (id: string, input: UpdateAddressBookEntryInput) => {
      const result = updateAddressService(id, input)
      if (result.success) {
        refreshEntries()
        notify({
          level: 'success',
          title: 'Address updated',
          description: `"${result.entry.name}" has been updated.`,
        })
        return result.entry
      } else {
        notify({
          level: 'error',
          title: 'Failed to update address',
          description: result.error,
        })
        throw new Error(result.error)
      }
    },
    [refreshEntries, notify]
  )

  /**
   * Delete an address from the address book.
   */
  const deleteAddress = useCallback(
    (id: string) => {
      const entry = entries.find((e) => e.id === id)
      const result = deleteAddressService(id)
      if (result.success) {
        refreshEntries()
        notify({
          level: 'success',
          title: 'Address deleted',
          description: entry
            ? `"${entry.name}" has been removed from your address book.`
            : 'Address has been removed from your address book.',
        })
      } else {
        notify({
          level: 'error',
          title: 'Failed to delete address',
          description: result.error,
        })
        throw new Error(result.error)
      }
    },
    [entries, refreshEntries, notify]
  )

  /**
   * Get addresses filtered by type.
   */
  const getAddressesByTypeFiltered = useCallback(
    (type: AddressType) => {
      return getAddressesByType(type)
    },
    []
  )

  /**
   * Search addresses by query.
   */
  const searchAddressesFiltered = useCallback((query: string) => {
    return searchAddresses(query)
  }, [])

  /**
   * Check if an address exists in the address book.
   */
  const checkAddressExists = useCallback((address: string) => {
    return addressExists(address)
  }, [])

  /**
   * Update filter settings.
   */
  const updateFilter = useCallback(
    (newFilter: Partial<AddressBookFilter>) => {
      setFilter((prev) => ({ ...prev, ...newFilter }))
    },
    [setFilter]
  )

  /**
   * Clear all filters.
   */
  const clearFilter = useCallback(() => {
    setFilter({
      type: 'all',
      searchQuery: '',
      sortBy: 'name',
      sortDirection: 'asc',
    })
  }, [setFilter])

  /**
   * Mark an address as used (increment usage count).
   */
  const markAddressUsed = useCallback(
    (id: string) => {
      incrementAddressUsage(id)
      refreshEntries()
    },
    [refreshEntries]
  )

  /**
   * Export address book to JSON file.
   */
  const exportToFile = useCallback(() => {
    try {
      const json = exportAddressBook()
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `address-book-${new Date().toISOString().split('T')[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      notify({
        level: 'success',
        title: 'Address book exported',
        description: 'Your address book has been downloaded.',
      })
    } catch (error) {
      notify({
        level: 'error',
        title: 'Export failed',
        description: error instanceof Error ? error.message : 'Failed to export address book',
      })
    }
  }, [notify])

  /**
   * Import address book from JSON file.
   */
  const importFromFile = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const content = e.target?.result
        if (typeof content === 'string') {
          const result = importAddressBook(content)
          if (result.success) {
            refreshEntries()
            notify({
              level: 'success',
              title: 'Address book imported',
              description: `${result.imported} address${result.imported === 1 ? '' : 'es'} imported successfully.`,
            })
          } else {
            notify({
              level: 'error',
              title: 'Import failed',
              description: result.error,
            })
          }
        }
      }
      reader.onerror = () => {
        notify({
          level: 'error',
          title: 'Import failed',
          description: 'Failed to read file',
        })
      }
      reader.readAsText(file)
    },
    [refreshEntries, notify]
  )

  return {
    // State
    addresses: entries,
    filteredAddresses: filteredEntries,
    filter,
    stats,

    // Operations
    addAddress,
    updateAddress,
    deleteAddress,
    refreshEntries,
    markAddressUsed,

    // Helpers
    getAddressesByType: getAddressesByTypeFiltered,
    searchAddresses: searchAddressesFiltered,
    addressExists: checkAddressExists,

    // Filter management
    updateFilter,
    clearFilter,

    // Import/Export
    exportToFile,
    importFromFile,
  }
}

