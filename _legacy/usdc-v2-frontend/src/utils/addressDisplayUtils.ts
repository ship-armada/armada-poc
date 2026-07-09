import { formatAddress } from '@/utils/toastHelpers'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import type { AddressBookEntry } from '@/services/addressBook/types'

/**
 * Address display information
 */
export interface AddressDisplayInfo {
  display: string
  isFromAddressBook: boolean
  fullAddress: string
}

/**
 * Get address display information (name from address book or truncated address)
 * 
 * @param address - The address to display
 * @param addressBookEntries - Optional array of address book entries (for reactive usage)
 * @returns Address display info or null if address is undefined
 */
export function getAddressDisplay(
  address: string | undefined,
  addressBookEntries?: AddressBookEntry[]
): AddressDisplayInfo | null {
  if (!address) return null
  
  // Check if address is in address book
  // If entries are provided, use them; otherwise fall back to service call
  const entries = addressBookEntries
  const addressBookEntry = entries
    ? entries.find((entry) => entry.address.toLowerCase() === address.toLowerCase().trim())
    : null
  
  if (addressBookEntry) {
    return { 
      display: addressBookEntry.name, 
      isFromAddressBook: true,
      fullAddress: address
    }
  }
  
  // Return truncated address
  return { 
    display: formatAddress(address), 
    isFromAddressBook: false,
    fullAddress: address
  }
}

/**
 * Check if a Namada address is a disposable address for a send transaction
 * 
 * @param address - The address to check
 * @param transaction - The transaction to check against
 * @returns True if the address is a disposable Namada address for this transaction
 */
export function isDisposableNamadaAddress(
  address: string | undefined,
  transaction: StoredTransaction
): boolean {
  if (!address || transaction.direction !== 'send') {
    return false
  }
  
  // For sends, check if address matches paymentData.disposableSignerAddress
  const txWithPaymentData = transaction as StoredTransaction & { 
    paymentData?: { disposableSignerAddress?: string } 
  }
  
  const disposableSignerAddress = txWithPaymentData.paymentData?.disposableSignerAddress
  
  if (!disposableSignerAddress) {
    return false
  }
  
  // Case-insensitive comparison
  return address.toLowerCase().trim() === disposableSignerAddress.toLowerCase().trim()
}

