import { cn } from '@/lib/utils'

export interface TransactionAmountDisplayProps {
  amount?: string
  chainName: string
  size?: 'sm' | 'md'
  layout?: 'horizontal' | 'vertical'
}

export function TransactionAmountDisplay({
  amount,
  chainName,
  size = 'md',
  layout = 'horizontal',
}: TransactionAmountDisplayProps) {
  const amountSize = size === 'sm' ? 'text-sm' : 'text-sm'
  const chainSize = size === 'sm' ? 'text-xs' : 'text-xs'

  if (layout === 'vertical') {
    return (
      <div className="flex flex-col items-center min-w-0">
        {amount && (
          <span className={cn('font-medium', amountSize)}>{amount}</span>
        )}
        <span className={cn('text-muted-foreground truncate', chainSize)}>
          {chainName}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      {amount && (
        <span className={cn('font-medium', amountSize)}>{amount}</span>
      )}
      <span className={cn('text-muted-foreground truncate', chainSize)}>
        {chainName}
      </span>
    </div>
  )
}

