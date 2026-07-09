/**
 * Main address book management component.
 * Provides full CRUD functionality for address book entries.
 */

import { useState, useRef } from 'react'
import { Plus, Search, Filter, X, Trash2, Download, Upload, BookOpen } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { AddressBookEntryCard } from './AddressBookEntryCard'
import { AddressBookForm } from './AddressBookForm'
import { AddressTypeBadge } from './AddressTypeBadge'
import { useAddressBook } from '@/hooks/useAddressBook'
import type { AddressBookEntry, AddressType } from '@/services/addressBook/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface DeleteConfirmationDialogProps {
  entry: AddressBookEntry | null
  onConfirm: () => void
  onCancel: () => void
}

function DeleteConfirmationDialog({
  entry,
  onConfirm,
  onCancel,
}: DeleteConfirmationDialogProps) {
  if (!entry) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-overlay backdrop-blur-sm transition-opacity"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div className="relative z-50 w-full max-w-md rounded-xl border border-destructive/20 bg-background shadow-2xl">
        <div className="p-6 space-y-4">
          <h3 className="text-lg font-semibold">Delete Address</h3>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete "{entry.name}"? This action cannot be undone.
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AddressBookManager() {
  const {
    filteredAddresses,
    filter,
    stats,
    addAddress,
    updateAddress,
    deleteAddress,
    updateFilter,
    clearFilter,
    exportToFile,
    importFromFile,
  } = useAddressBook()
  
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [showForm, setShowForm] = useState(false)
  const [editingEntry, setEditingEntry] = useState<AddressBookEntry | null>(null)
  const [deletingEntry, setDeletingEntry] = useState<AddressBookEntry | null>(null)
  const [searchQuery, setSearchQuery] = useState(filter.searchQuery || '')

  const handleAddNew = () => {
    setEditingEntry(null)
    setShowForm(true)
  }

  const handleEdit = (entry: AddressBookEntry) => {
    setEditingEntry(entry)
    setShowForm(true)
  }

  const handleDelete = (entry: AddressBookEntry) => {
    setDeletingEntry(entry)
  }

  const handleConfirmDelete = () => {
    if (deletingEntry) {
      deleteAddress(deletingEntry.id)
      setDeletingEntry(null)
    }
  }

  const handleFormSubmit = (data: {
    name: string
    address: string
    type: AddressType
    notes?: string
  }) => {
    if (editingEntry) {
      updateAddress(editingEntry.id, {
        name: data.name,
        address: data.address,
        type: data.type,
        metadata: {
          ...editingEntry.metadata,
          notes: data.notes,
        },
      })
    } else {
      addAddress({
        name: data.name,
        address: data.address,
        type: data.type,
        metadata: {
          notes: data.notes,
        },
      })
    }
    setShowForm(false)
    setEditingEntry(null)
  }

  const handleFormCancel = () => {
    setShowForm(false)
    setEditingEntry(null)
  }

  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    updateFilter({ searchQuery: value })
  }

  const handleTypeFilterChange = (value: string) => {
    updateFilter({ type: value === 'all' ? 'all' : (value as AddressType) })
  }

  const handleSortChange = (value: string) => {
    const [sortBy, direction] = value.split('-') as [string, 'asc' | 'desc']
    updateFilter({ sortBy: sortBy as any, sortDirection: direction })
  }

  const hasActiveFilters =
    filter.type !== 'all' || (filter.searchQuery && filter.searchQuery.trim() !== '')

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Address Book</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your saved addresses ({stats.total} total)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={showForm}
          >
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>
          <Button variant="secondary" onClick={exportToFile} disabled={showForm || stats.total === 0}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
          <Button variant="primary" onClick={handleAddNew} disabled={showForm}>
            <Plus className="h-4 w-4 mr-2" />
            Add Address
          </Button>
        </div>
      </div>
      
      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) {
            importFromFile(file)
            e.target.value = '' // Reset input
          }
        }}
      />

      {/* Filters and search */}
      {!showForm && (
        <div className="card space-y-4">
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Search */}
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search by name or address..."
                className="w-full pl-9 pr-9 py-2 text-sm rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:border-ring focus:ring-ring"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => handleSearchChange('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Type filter */}
            <Select value={filter.type || 'all'} onValueChange={handleTypeFilterChange}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="evm">EVM</SelectItem>
                <SelectItem value="namada">Namada</SelectItem>
                <SelectItem value="noble">Noble</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>

            {/* Sort */}
            <Select
              value={`${filter.sortBy || 'name'}-${filter.sortDirection || 'asc'}`}
              onValueChange={handleSortChange}
            >
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name-asc">Name (A-Z)</SelectItem>
                <SelectItem value="name-desc">Name (Z-A)</SelectItem>
                <SelectItem value="date-desc">Newest First</SelectItem>
                <SelectItem value="date-asc">Oldest First</SelectItem>
                <SelectItem value="type-asc">Type (A-Z)</SelectItem>
                <SelectItem value="type-desc">Type (Z-A)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Active filters indicator */}
          {hasActiveFilters && (
            <div className="flex items-center gap-2 pt-2 border-t border-border">
              <span className="text-xs text-muted-foreground">Active filters:</span>
              {filter.type !== 'all' && (
                <div className="flex items-center gap-1">
                  <AddressTypeBadge type={filter.type as AddressType} />
                  <button
                    type="button"
                    onClick={() => updateFilter({ type: 'all' })}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
              {filter.searchQuery && (
                <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-xs">
                  Search: {filter.searchQuery}
                  <button
                    type="button"
                    onClick={() => handleSearchChange('')}
                    className="hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
              <Button
                variant="ghost"
                onClick={clearFilter}
                className="ml-auto text-xs h-6 px-2 py-1"
              >
                Clear all
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Form or list */}
      {showForm ? (
        <div className="card">
          <div className="mb-4">
            <h3 className="text-lg font-semibold">
              {editingEntry ? 'Edit Address' : 'Add New Address'}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {editingEntry
                ? 'Update the address information below.'
                : 'Save an address to your address book for quick access.'}
            </p>
          </div>
          <AddressBookForm
            entry={editingEntry || undefined}
            onSubmit={handleFormSubmit}
            onCancel={handleFormCancel}
          />
        </div>
      ) : filteredAddresses.length === 0 ? (
        <div className="card text-center py-12">
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-full bg-muted-foreground/10 p-6">
              <BookOpen className="h-12 w-12 text-muted-foreground" />
            </div>
            <p className="text-muted-foreground">
              {hasActiveFilters
                ? 'No addresses match your filters.'
                : 'No addresses saved yet.'}
            </p>
            {hasActiveFilters ? (
              <Button variant="secondary" onClick={clearFilter}>
                Clear filters
              </Button>
            ) : (
              <Button variant="primary" onClick={handleAddNew}>
                <Plus className="h-4 w-4 mr-2" />
                Add your first address
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredAddresses.map((entry) => (
            <AddressBookEntryCard
              key={entry.id}
              entry={entry}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <DeleteConfirmationDialog
        entry={deletingEntry}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletingEntry(null)}
      />
    </div>
  )
}

