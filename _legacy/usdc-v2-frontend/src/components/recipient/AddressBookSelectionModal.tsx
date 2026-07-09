/**
 * Modal component for selecting an address from the address book.
 */

import { useEffect, useState } from 'react'
import { X, Search } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { AddressTypeBadge } from '@/components/addressBook/AddressTypeBadge'
import { filterAddresses } from '@/services/addressBook/addressBookService'
import type { AddressBookEntry, AddressType } from '@/services/addressBook/types'

interface AddressBookSelectionModalProps {
  open: boolean
  onClose: () => void
  onSelect: (entry: AddressBookEntry) => void
  filterByType: AddressType
}

export function AddressBookSelectionModal({
  open,
  onClose,
  onSelect,
  filterByType,
}: AddressBookSelectionModalProps) {
  const [searchQuery, setSearchQuery] = useState('')

  // Filter addresses by type and search query
  const filteredAddresses = filterAddresses({
    type: filterByType,
    searchQuery: searchQuery.trim() || undefined,
  })

  // Handle Escape key to close modal
  useEffect(() => {
    if (!open) return

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open, onClose])

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
      // Reset search when closing
      setSearchQuery('')
    }

    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  const handleSelect = (entry: AddressBookEntry) => {
    onSelect(entry)
    onClose()
  }

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-overlay backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Content */}
      <div className="relative z-50 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Select from Address Book</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search bar */}
        <div className="mb-4 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search addresses..."
            className="w-full pl-9 pr-4 py-2 text-sm rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:border-ring focus:ring-ring"
            autoFocus
          />
        </div>

        {/* Address list */}
        <div className="max-h-96 overflow-y-auto space-y-2">
          {filteredAddresses.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {searchQuery ? 'No addresses found' : 'No addresses saved'}
            </div>
          ) : (
            filteredAddresses.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => handleSelect(entry)}
                className="w-full text-left p-3 rounded-md border border-input hover:bg-muted/50 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium truncate">{entry.name}</span>
                      <AddressTypeBadge type={entry.type} />
                    </div>
                    <code className="text-xs font-mono text-muted-foreground break-all">
                      {entry.address}
                    </code>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
