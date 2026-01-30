import { ExplorerLink } from './ExplorerLink'
import { CopyButton } from './CopyButton'
import { cn } from '@/lib/utils'

interface AddressDisplayProps {
  value: string
  explorerUrl?: string
  label?: string
  format?: 'short' | 'medium' | 'full'
  showCopy?: boolean
  showExplorer?: boolean
  className?: string
  copyLabel?: string
  explorerLabel?: string
  size?: 'sm' | 'md' | 'lg'
}

const formatAddress = (value: string, format: 'short' | 'medium' | 'full'): string => {
  if (format === 'full') return value
  if (value.length <= 10) return value
  
  switch (format) {
    case 'short':
      return `${value.slice(0, 6)}...${value.slice(-4)}`
    case 'medium':
      return `${value.slice(0, 10)}...${value.slice(-8)}`
    default:
      return value
  }
}

export function AddressDisplay({
  value,
  explorerUrl,
  label,
  format = 'short',
  showCopy = true,
  showExplorer = true,
  className,
  copyLabel,
  explorerLabel,
  size = 'md',
}: AddressDisplayProps) {
  const formattedValue = formatAddress(value, format)
  const textSizeClass = size === 'sm' ? 'text-xs' : 'text-sm'

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className={cn('font-mono', textSizeClass)}>{formattedValue}</span>
      <div className="flex items-center gap-1">
        {showCopy && (
          <CopyButton
            text={value}
            label={copyLabel || label || 'Address'}
            size={size}
          />
        )}
        {showExplorer && explorerUrl && (
          <ExplorerLink
            url={explorerUrl}
            label={explorerLabel || label || 'View in explorer'}
            size={size}
            iconOnly
            className="p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors rounded flex-shrink-0"
          />
        )}
      </div>
    </div>
  )
}
