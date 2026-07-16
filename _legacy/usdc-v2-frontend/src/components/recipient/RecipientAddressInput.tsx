/**
 * Unified recipient address input component.
 * Combines address input, address book integration, validation, and name management.
 */

import { useState, useEffect, useRef } from 'react'
import { BookOpen, Zap } from 'lucide-react'
import { AlertCircle } from 'lucide-react'
import { Tooltip } from '@/components/common/Tooltip'
import { AddressMatchDropdown } from './AddressMatchDropdown'
import { AddressBookSelectionModal } from './AddressBookSelectionModal'
import { RecipientNameDisplay } from './RecipientNameDisplay'
import { searchAddresses } from '@/services/addressBook/addressBookService'
import type { AddressBookEntry } from '@/services/addressBook/types'
import type { RecipientAddressInputProps } from './types'
import { cn } from '@/lib/utils'

export function RecipientAddressInput({
  value,
  onChange,
  onNameChange,
  onNameValidationChange,
  addressType,
  validationError,
  autoFillAddress,
  onAutoFill,
  disabled = false,
  placeholder,
  className,
}: RecipientAddressInputProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [matches, setMatches] = useState<AddressBookEntry[]>([])
  const [isInputFocused, setIsInputFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isSelectingRef = useRef(false)

  // Get placeholder based on address type
  const defaultPlaceholder =
    placeholder || (addressType === 'evm' ? '0x...' : 'tnam...')

  // Search address book as user types
  useEffect(() => {
    // Don't open dropdown if we just selected an address
    if (isSelectingRef.current) {
      isSelectingRef.current = false
      setMatches([])
      setIsDropdownOpen(false)
      return
    }

    if (!value || value.trim() === '') {
      setMatches([])
      setIsDropdownOpen(false)
      return
    }

    // Only show dropdown when input is focused and user is typing
    if (!isInputFocused) {
      setMatches([])
      setIsDropdownOpen(false)
      return
    }

    // Search address book
    const searchResults = searchAddresses(value)
    // Filter by address type
    const filteredResults = searchResults.filter((entry) => entry.type === addressType)

    // Limit to 5 results for dropdown
    const limitedResults = filteredResults.slice(0, 5)

    if (limitedResults.length > 0) {
      setMatches(limitedResults)
      setIsDropdownOpen(true)
    } else {
      setMatches([])
      setIsDropdownOpen(false)
    }
  }, [value, addressType, isInputFocused])

  // Handle address selection from dropdown
  const handleSelectMatch = (entry: AddressBookEntry) => {
    isSelectingRef.current = true
    onChange(entry.address)
    setIsDropdownOpen(false)
    inputRef.current?.blur()
  }

  // Handle address selection from modal
  const handleSelectFromModal = (entry: AddressBookEntry) => {
    isSelectingRef.current = true
    onChange(entry.address)
    setIsModalOpen(false)
  }

  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
  }

  // Handle auto-fill
  const handleAutoFillClick = () => {
    if (autoFillAddress && onAutoFill) {
      onAutoFill()
    } else if (autoFillAddress) {
      onChange(autoFillAddress)
    }
  }

  return (
    <div className={cn('relative', className)} ref={containerRef}>
      {/* Input field with buttons */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleInputChange}
          onFocus={() => setIsInputFocused(true)}
          onBlur={() => {
            // Delay blur to allow click events on dropdown items
            setTimeout(() => {
              setIsInputFocused(false)
              setIsDropdownOpen(false)
            }, 200)
          }}
          placeholder={`${defaultPlaceholder} or address book name`}
          disabled={disabled}
          className={cn(
            'w-full rounded-lg border bg-background px-4 py-3 pr-24 text-sm font-mono shadow-sm',
            'focus-visible:outline-none focus-visible:ring-2 transition-colors',
            validationError && value.trim() !== ''
              ? 'border-destructive focus-visible:ring-destructive/20 focus-visible:border-destructive'
              : 'border-input focus-visible:ring-ring focus-visible:border-ring',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        />

        {/* Action buttons */}
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {/* Auto-fill button */}
          {autoFillAddress && (
            <Tooltip content="Auto-fill with connected wallet address" side="top">
              <button
                type="button"
                onClick={handleAutoFillClick}
                disabled={disabled || !autoFillAddress}
                className={cn(
                  'p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50',
                  'transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
                  (!autoFillAddress || disabled) && 'opacity-50 cursor-not-allowed'
                )}
              >
                <Zap className="h-4 w-4" />
              </button>
            </Tooltip>
          )}

          {/* Address book button */}
          <Tooltip content="Select from address book" side="top">
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              disabled={disabled}
              className={cn(
                'p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50',
                'transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
                disabled && 'opacity-50 cursor-not-allowed'
              )}
            >
              <BookOpen className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Dropdown for address matches */}
      <AddressMatchDropdown
        matches={matches}
        onSelect={handleSelectMatch}
        onClose={() => setIsDropdownOpen(false)}
        isOpen={isDropdownOpen}
      />

      {/* Address book selection modal */}
      <AddressBookSelectionModal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelect={handleSelectFromModal}
        filterByType={addressType}
      />

      {/* Validation error */}
      {validationError && value.trim() !== '' && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="flex-1">{validationError}</span>
        </div>
      )}

      {/* Name display/save */}
      {!validationError && value.trim() !== '' && (
        <RecipientNameDisplay
          address={value}
          onNameChange={onNameChange || (() => {})}
          onValidationChange={onNameValidationChange}
          addressType={addressType}
        />
      )}
    </div>
  )
}
