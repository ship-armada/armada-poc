import { User } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AddressDisplayInfo } from '@/utils/addressDisplayUtils'

export interface TransactionAddressRowProps {
  addressDisplayInfo: AddressDisplayInfo | null
  direction: 'deposit' | 'send'
  size?: 'sm' | 'md'
}

export function TransactionAddressRow({
  addressDisplayInfo,
  direction,
  size = 'md',
}: TransactionAddressRowProps) {
  if (!addressDisplayInfo) return null

  const textSize = size === 'sm' ? 'text-xs' : 'text-xs'
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3 w-3'

  return (
    <div className={cn('flex items-center gap-1 text-muted-foreground truncate', textSize)}>
      <span>{direction === 'deposit' ? 'From: ' : 'To: '}</span>
      {addressDisplayInfo.isFromAddressBook && (
        <User className={cn(iconSize, 'text-success flex-shrink-0')} />
      )}
      <span className="truncate">{addressDisplayInfo.display}</span>
    </div>
  )
}

