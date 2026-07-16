/**
 * Form component for adding/editing address book entries.
 */

import { useState, useEffect } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { AddressTypeBadge } from './AddressTypeBadge'
import { detectAddressType } from '@/services/addressBook/addressTypeDetector'
import { validateAddressBookName, validateAddressBookMemo } from '@/utils/addressBookValidation'
import type { AddressBookEntry, AddressType } from '@/services/addressBook/types'

interface AddressBookFormProps {
  entry?: AddressBookEntry // If provided, form is in edit mode
  onSubmit: (data: { name: string; address: string; type: AddressType; notes?: string }) => void
  onCancel: () => void
}

export function AddressBookForm({ entry, onSubmit, onCancel }: AddressBookFormProps) {
  const [name, setName] = useState(entry?.name ?? '')
  const [address, setAddress] = useState(entry?.address ?? '')
  const [notes, setNotes] = useState(entry?.metadata?.notes ?? '')
  const [detectedType, setDetectedType] = useState<AddressType | null>(entry?.type ?? null)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [memoError, setMemoError] = useState<string | null>(null)

  const isEditMode = !!entry

  // Detect address type when address changes
  useEffect(() => {
    if (address.trim()) {
      const detection = detectAddressType(address)
      if (detection.isValid && detection.type) {
        setDetectedType(detection.type)
        setAddressError(null)
        if (detection.normalizedAddress && detection.normalizedAddress !== address) {
          // Auto-update to normalized address
          setAddress(detection.normalizedAddress)
        }
      } else {
        setDetectedType(null)
        setAddressError(detection.error || 'Invalid address format')
      }
    } else {
      setDetectedType(null)
      setAddressError(null)
    }
  }, [address])

  // Validate name using validation utility
  useEffect(() => {
    if (!address.trim()) {
      // Don't validate name if address is empty (will be caught in submit)
      setNameError(null)
      return
    }

    // Skip address existence check in edit mode (exclude current entry)
    const validation = validateAddressBookName(name, address, entry?.id)
    
    if (!validation.isValid) {
      setNameError(validation.error)
    } else {
      setNameError(null)
    }
  }, [name, address, entry?.id])

  // Validate memo
  useEffect(() => {
    const validation = validateAddressBookMemo(notes)
    
    if (!validation.isValid) {
      setMemoError(validation.error)
    } else {
      setMemoError(null)
    }
  }, [notes])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    // Validate name
    if (!address.trim()) {
      setAddressError('Address is required')
      return
    }

    const nameValidation = validateAddressBookName(name, address, entry?.id)
    if (!nameValidation.isValid) {
      setNameError(nameValidation.error)
      return
    }

    // Validate memo
    const memoValidation = validateAddressBookMemo(notes)
    if (!memoValidation.isValid) {
      setMemoError(memoValidation.error)
      return
    }

    if (!detectedType) {
      setAddressError('Invalid address format')
      return
    }

    // Submit
    onSubmit({
      name: name.trim(),
      address: address.trim(),
      type: detectedType,
      notes: notes.trim() || undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="address-name" className="block text-sm font-medium mb-2">
          Name <span className="text-destructive">*</span>
        </label>
        <input
          id="address-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={24}
          className={`w-full rounded-md border px-3 py-2 text-sm ${
            nameError
              ? 'border-destructive focus:border-destructive focus:ring-destructive'
              : 'border-input focus:border-ring focus:ring-ring'
          } bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2`}
          placeholder="e.g. My Wallet"
          required
        />
        {nameError && (
          <p className="mt-1 text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            {nameError}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="address-value" className="block text-sm font-medium mb-2">
          Address <span className="text-destructive">*</span>
        </label>
        <textarea
          id="address-value"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className={`w-full rounded-md border px-3 py-2 text-sm font-mono ${
            addressError
              ? 'border-destructive focus:border-destructive focus:ring-destructive'
              : 'border-input focus:border-ring focus:ring-ring'
          } bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 resize-none`}
          placeholder="0x... or tnam1... or noble1..."
          rows={1}
          required
        />
        {detectedType && !addressError && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Detected type:</span>
            <AddressTypeBadge type={detectedType} />
          </div>
        )}
        {addressError && (
          <p className="mt-1 text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            {addressError}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="address-notes" className="block text-sm font-medium mb-2">
          Memo (optional)
        </label>
        <textarea
          id="address-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={200}
          className={`w-full rounded-md border px-3 py-2 text-sm bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 resize-none ${
            memoError
              ? 'border-destructive focus:border-destructive focus:ring-destructive'
              : 'border-input focus:border-ring focus:ring-ring'
          }`}
          placeholder="Additional notes about this address..."
          rows={2}
        />
        {memoError && (
          <p className="mt-1 text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            {memoError}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!!nameError || !!addressError || !!memoError || !detectedType}
        >
          {isEditMode ? 'Update Address' : 'Add Address'}
        </Button>
      </div>
    </form>
  )
}

