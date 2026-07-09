import { CopyButton } from './CopyButton'
import { ExplorerLink } from './ExplorerLink'
import { cn } from '@/lib/utils'

interface InfoRowProps {
  label: string
  value: string | React.ReactNode
  explorerUrl?: string
  onCopy?: () => void
  className?: string
  valueClassName?: string
  size?: 'sm' | 'md' | 'lg'
  copyText?: string // Optional text to copy (if value is ReactNode)
}

export function InfoRow({
  label,
  value,
  explorerUrl,
  onCopy,
  className,
  valueClassName,
  size = 'md',
  copyText,
}: InfoRowProps) {
  const textSizeClass = size === 'sm' ? 'text-xs' : size === 'md' ? 'text-sm' : size === 'lg' ? 'text-base' : 'text-sm'
  const isStringValue = typeof value === 'string'
  const textToCopy = copyText || (isStringValue ? value : undefined)

  return (
    <div className={cn('space-y-2', className)}>
      <dt className={cn('text-muted-foreground', 'text-sm')}>{label}</dt>
      <dd>
        <div className="flex items-center justify-start gap-2">
          {isStringValue ? (
            <span className={cn(textSizeClass, 'font-mono', valueClassName)}>{value}</span>
          ) : (
            <div className={cn(textSizeClass, valueClassName)}>{value}</div>
          )}
          {textToCopy && (
            <div className="gap-0 flex">
              <CopyButton
                text={textToCopy}
                label={label}
                size='md'
                onCopy={onCopy}
              />
              {explorerUrl && (
                <ExplorerLink
                  url={explorerUrl}
                  label={`Open ${label} in explorer`}
                  size='md'
                  iconOnly
                  className="explorer-link-inline"
                />
              )}
            </div>
          )}
        </div>
      </dd>
    </div>
  )
}
