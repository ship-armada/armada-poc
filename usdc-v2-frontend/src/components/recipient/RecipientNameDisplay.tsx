/**
 * Component for displaying or saving recipient name.
 * Shows name if address is in address book, or allows saving if not.
 */

import { useState, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { Check, AlertCircle } from 'lucide-react'
import { validateAddressBookName } from '@/utils/addressBookValidation'
import { addressBookAtom } from '@/atoms/addressBookAtom'
import { cn } from '@/lib/utils'

interface RecipientNameDisplayProps {
  address: string
  onNameChange: (name: string | null) => void
  onValidationChange?: (isValid: boolean, error: string | null) => void
  addressType: 'evm' | 'namada'
}

export function RecipientNameDisplay({
  address,
  onNameChange,
  onValidationChange,
  addressType: _addressType,
}: RecipientNameDisplayProps) {
  const [saveToAddressBook, setSaveToAddressBook] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)

  // Get address book entries reactively
  const addressBookEntries = useAtomValue(addressBookAtom)
  
  // Check if address exists in address book
  const addressBookEntry = addressBookEntries.find(
    (entry) => entry.address.toLowerCase() === address.toLowerCase().trim()
  )

  // Validate name when it changes
  useEffect(() => {
    if (!saveToAddressBook) {
      setNameError(null)
      onNameChange(null)
      return
    }

    // Use validation utility
    const validation = validateAddressBookName(nameInput, address)

    if (!validation.isValid) {
      setNameError(validation.error)
      onNameChange(null)
      return
    }

    // Name is valid
    setNameError(null)
    onNameChange(nameInput.trim())
    onValidationChange?.(true, null)
  }, [saveToAddressBook, nameInput, address, onNameChange, onValidationChange])

  // Notify parent of validation state changes
  useEffect(() => {
    if (!saveToAddressBook) {
      onValidationChange?.(true, null)
      return
    }

    if (nameError) {
      onValidationChange?.(false, nameError)
    } else if (!nameInput.trim()) {
      onValidationChange?.(false, 'Name is required')
    } else {
      onValidationChange?.(true, null)
    }
  }, [saveToAddressBook, nameInput, nameError, onValidationChange])

  // Reset when address changes
  useEffect(() => {
    setSaveToAddressBook(false)
    setNameInput('')
    setNameError(null)
    onNameChange(null)
  }, [address, onNameChange])

  // If address is in address book, show the name
  if (addressBookEntry) {
    return (
      <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Check className="h-4 w-4 text-success" />
        <span>
          <span className="font-medium text-foreground">{addressBookEntry.name}</span>
          {' '}from address book
        </span>
      </div>
    )
  }

  // If address is not in address book and address is valid, show save option
  const isValidAddress = address.trim() !== ''
  if (!isValidAddress) {
    return null
  }

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={saveToAddressBook}
            onChange={(e) => {
              setSaveToAddressBook(e.target.checked)
              if (!e.target.checked) {
                setNameInput('')
                setNameError(null)
                onNameChange(null)
              }
            }}
            className="w-3 h-3 rounded border-input text-primary focus:ring-2 focus:ring-ring"
          />
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            Save to address book
          </span>
        </label>

        {saveToAddressBook && (
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            maxLength={24}
            placeholder="Enter a name for this address"
            className={cn(
              'flex-1 rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
              'focus-visible:outline-none focus-visible:ring-2 transition-colors',
              nameError
                ? 'border-destructive focus-visible:ring-destructive/20 focus-visible:border-destructive'
                : 'border-input focus-visible:ring-ring focus-visible:border-ring'
            )}
          />
        )}
      </div>
      {nameError && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{nameError}</span>
        </div>
      )}
    </div>
  )
}
