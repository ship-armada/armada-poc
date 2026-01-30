/**
 * Dropdown component that displays matching address book entries as the user types.
 */

import { useEffect, useRef, useState } from 'react'
import { AddressTypeBadge } from '@/components/addressBook/AddressTypeBadge'
import type { AddressBookEntry } from '@/services/addressBook/types'
import { cn } from '@/lib/utils'

interface AddressMatchDropdownProps {
  matches: AddressBookEntry[]
  onSelect: (entry: AddressBookEntry) => void
  onClose: () => void
  isOpen: boolean
  className?: string
}

export function AddressMatchDropdown({
  matches,
  onSelect,
  onClose,
  isOpen,
  className,
}: AddressMatchDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState<number>(-1)

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen || matches.length === 0) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex((prev) => {
          const newIndex = Math.min(prev + 1, matches.length - 1)
          scrollToSelected(newIndex)
          return newIndex
        })
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((prev) => {
          const newIndex = Math.max(prev - 1, 0)
          scrollToSelected(newIndex)
          return newIndex
        })
      } else if (event.key === 'Enter' && selectedIndex >= 0) {
        event.preventDefault()
        onSelect(matches[selectedIndex])
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    function scrollToSelected(index: number) {
      const element = dropdownRef.current?.children[index] as HTMLElement
      if (element) {
        element.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, matches, onSelect, onClose, selectedIndex])

  // Reset selected index when matches change
  useEffect(() => {
    setSelectedIndex(-1)
  }, [matches])

  // Handle outside click
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        onClose()
      }
    }

    // Use setTimeout to avoid immediate close when opening
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, onClose])

  if (!isOpen || matches.length === 0) {
    return null
  }

  return (
    <div
      ref={dropdownRef}
      className={cn(
        'absolute z-50 mt-1 w-full rounded-lg border border-input bg-background shadow-lg max-h-64 overflow-y-auto',
        className
      )}
    >
      {matches.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onSelect(entry)}
          className={cn(
            'w-full text-left p-3 rounded-md transition-colors',
            'hover:bg-muted/50 focus:bg-muted/50 focus:outline-none',
            index === selectedIndex && 'bg-muted/50'
          )}
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
  )
}
