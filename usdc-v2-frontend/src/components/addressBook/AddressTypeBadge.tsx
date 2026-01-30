/**
 * Badge component for displaying address type.
 * Color-coded by address type.
 */

import { cn } from '@/lib/utils'
import type { AddressType } from '@/services/addressBook/types'

interface AddressTypeBadgeProps {
  type: AddressType
  className?: string
}

const typeStyles: Record<AddressType, string> = {
  evm: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  namada: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
  noble: 'bg-green-500/10 text-green-600 dark:text-green-400',
  other: 'bg-gray-500/10 text-gray-600 dark:text-gray-400',
}

const typeLabels: Record<AddressType, string> = {
  evm: 'EVM',
  namada: 'Namada',
  noble: 'Noble',
  other: 'Other',
}

export function AddressTypeBadge({ type, className }: AddressTypeBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        typeStyles[type],
        className
      )}
    >
      {typeLabels[type]}
    </span>
  )
}

