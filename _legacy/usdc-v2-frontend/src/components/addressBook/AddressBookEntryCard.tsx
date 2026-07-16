/**
 * Card component for displaying a single address book entry.
 */

import { useState } from 'react'
import { Edit2, Trash2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { CopyButton } from '@/components/common/CopyButton'
import { AddressTypeBadge } from './AddressTypeBadge'
import type { AddressBookEntry } from '@/services/addressBook/types'

interface AddressBookEntryCardProps {
  entry: AddressBookEntry
  onEdit: (entry: AddressBookEntry) => void
  onDelete: (entry: AddressBookEntry) => void
}

function truncateAddress(address: string, startChars = 6, endChars = 4): string {
  if (address.length <= startChars + endChars) {
    return address
  }
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`
}

export function AddressBookEntryCard({
  entry,
  onEdit,
  onDelete,
}: AddressBookEntryCardProps) {
  const [showFullAddress, setShowFullAddress] = useState(false)

  const displayAddress = showFullAddress ? entry.address : truncateAddress(entry.address)

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-semibold truncate">{entry.name}</h3>
            <AddressTypeBadge type={entry.type} />
          </div>
          
          <div className="flex items-center gap-2 mb-2">
            <code className="text-xs font-mono text-muted-foreground break-all">
              {displayAddress}
            </code>
            <button
              type="button"
              onClick={() => setShowFullAddress(!showFullAddress)}
              className="text-xs text-primary hover:text-primary/80 transition-colors"
            >
              {showFullAddress ? 'Show less' : 'Show more'}
            </button>
            <CopyButton text={entry.address} label="Address" size="sm" />
          </div>

          {entry.metadata?.notes && (
            <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
              {entry.metadata.notes}
            </p>
          )}

          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
            <span>Added {new Date(entry.createdAt).toLocaleDateString()}</span>
            {entry.metadata?.usageCount && entry.metadata.usageCount > 0 && (
              <span>Used {entry.metadata.usageCount} time{entry.metadata.usageCount === 1 ? '' : 's'}</span>
            )}
            {entry.metadata?.lastUsedAt && (
              <span>Last used {new Date(entry.metadata.lastUsedAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            onClick={() => onEdit(entry)}
            className="h-8 w-8 p-0"
            aria-label={`Edit ${entry.name}`}
          >
            <Edit2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            onClick={() => onDelete(entry)}
            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
            aria-label={`Delete ${entry.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

