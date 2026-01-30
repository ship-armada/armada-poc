import { addAddress } from '@/services/addressBook/addressBookService'
import type { AddressType } from '@/services/addressBook/types'

export interface SaveAddressToBookParams {
  name: string | null
  address: string
  type: AddressType
  onSuccess?: (name: string) => void
  onError?: (error: string) => void
}

/**
 * Save an address to the address book if a name was provided.
 * This is a non-blocking operation that doesn't throw errors.
 * 
 * @param params - Parameters for saving the address
 * @returns Promise that resolves when the save operation completes (success or failure)
 */
export async function saveAddressToBook(params: SaveAddressToBookParams): Promise<void> {
  const { name, address, type, onSuccess, onError } = params

  if (!name || !address) {
    return
  }

  try {
    const result = addAddress({
      name,
      address,
      type,
    })

    if (result.success) {
      onSuccess?.(name)
    } else {
      onError?.(result.error || 'Could not save address to address book')
    }
  } catch (error) {
    // Catch any unexpected errors
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred'
    onError?.(errorMessage)
  }
}

