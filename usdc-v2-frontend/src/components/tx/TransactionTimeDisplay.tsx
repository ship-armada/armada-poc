import { Clock } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TransactionTimeDisplayProps {
  timeElapsed: string
  size?: 'sm' | 'md'
}

export function TransactionTimeDisplay({
  timeElapsed,
  size = 'md',
}: TransactionTimeDisplayProps) {
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs'
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'

  return (
    <div className={cn('flex items-center gap-1 text-muted-foreground min-w-0', textSize)}>
      <Clock className={cn(iconSize, 'flex-shrink-0')} />
      <span>{timeElapsed}</span>
    </div>
  )
}

