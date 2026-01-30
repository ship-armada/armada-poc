/**
 * Reusable component for selecting addresses from the address book.
 * Can be used in SendPayment, Deposit pages, etc.
 */

import { useState } from 'react'
import { Search, Plus, X } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { AddressTypeBadge } from './AddressTypeBadge'
import { useAddressBook } from '@/hooks/useAddressBook'
import type { AddressBookEntry, AddressType } from '@/services/addressBook/types'
import { useNavigate } from 'react-router-dom'

interface AddressBookSelectorProps {
  onSelect: (entry: AddressBookEntry) => void
  onAddNew?: () => void
  filterByType?: AddressType // Only show addresses of this type
  className?: string
}

export function AddressBookSelector({
  onSelect,
  onAddNew,
  filterByType,
  className,
}: AddressBookSelectorProps) {
  const { filteredAddresses, markAddressUsed } = useAddressBook()
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Filter addresses by type if specified
  const availableAddresses = filterByType
    ? filteredAddresses.filter((entry) => entry.type === filterByType)
    : filteredAddresses

  // Apply search filter
  const displayAddresses = searchQuery.trim()
    ? availableAddresses.filter(
        (entry) =>
          entry.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          entry.address.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : availableAddresses

  const handleSelect = (entry: AddressBookEntry) => {
    onSelect(entry)
    markAddressUsed(entry.id)
    setIsOpen(false)
    setSearchQuery('')
  }

  return (
    <div className={className}>
      <Button
        type="button"
        variant="secondary"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full justify-between"
      >
        <span>Select from Address Book</span>
        <span className="text-xs text-muted-foreground">
          {availableAddresses.length} saved
        </span>
      </Button>

      {isOpen && (
        <div className="mt-2 card">
          <div className="space-y-3">
            {/* Search bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search addresses..."
                className="w-full pl-9 pr-9 py-2 text-sm rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:border-ring focus:ring-ring"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Address list */}
            {displayAddresses.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {searchQuery ? 'No addresses found' : 'No addresses saved'}
                {onAddNew && (
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setIsOpen(false)
                        if (onAddNew) {
                          onAddNew()
                        } else {
                          navigate('/address-book')
                        }
                      }}
                      className="text-xs h-8"
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Add new address
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-2">
                {displayAddresses.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => handleSelect(entry)}
                    className="w-full text-left p-3 rounded-md border border-input hover:bg-muted/50 transition-colors"
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
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

