import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TransactionStatusBadgeProps {
  statusLabel: string
  hasTimeout: boolean
  timeoutMessage?: string
  size?: 'sm' | 'md'
  variant?: 'rounded-sm' | 'rounded-md' | 'rounded-full'
  badgeClasses: {
    bg: string
    text: string
    border: string
  }
}

export function TransactionStatusBadge({
  statusLabel,
  hasTimeout,
  timeoutMessage,
  size = 'md',
  variant = 'rounded-sm',
  badgeClasses,
}: TransactionStatusBadgeProps) {
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-[10px]'
  const padding = size === 'sm' ? 'px-1.5 py-0.5' : 'px-2 py-0.5'
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'

  return (
    <div className="flex items-center gap-1.5">
      <div className={cn(
        'inline-flex items-center gap-1',
        variant,
        padding,
        badgeClasses.bg,
        badgeClasses.text,
        badgeClasses.border
      )}>
        <span className={cn('font-medium', textSize, size === 'sm' && 'leading-tight')}>
          {statusLabel}
        </span>
      </div>
      
      {hasTimeout && (
        <div className="group relative">
          <AlertCircle className={cn(iconSize, 'text-warning')} />
          {timeoutMessage && (
            <div className="absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow-lg transition-opacity group-hover:block group-hover:opacity-100">
              {timeoutMessage}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

