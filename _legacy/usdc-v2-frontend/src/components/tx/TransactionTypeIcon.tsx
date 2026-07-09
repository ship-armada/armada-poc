import { ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TransactionTypeIconProps {
  direction: 'deposit' | 'send'
  iconBgColor: string
  iconTextColor: string
  size?: 'sm' | 'md'
}

export function TransactionTypeIcon({
  direction,
  iconBgColor,
  iconTextColor,
  size = 'md',
}: TransactionTypeIconProps) {
  const iconSize = size === 'sm' ? 'h-6 w-6' : 'h-6 w-6'
  const containerSize = size === 'sm' ? 'h-8 w-8' : 'h-8 w-8'

  return (
    <div className={cn("flex items-center justify-center rounded-md", containerSize, iconBgColor)}>
      {direction === 'deposit' ? (
        <ArrowDownLeft className={cn(iconSize, iconTextColor)} />
      ) : (
        <ArrowUpRight className={cn(iconSize, iconTextColor)} />
      )}
    </div>
  )
}

