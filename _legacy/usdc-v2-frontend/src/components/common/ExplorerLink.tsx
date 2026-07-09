import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ExplorerLinkProps {
  url: string
  label?: string
  children?: React.ReactNode
  className?: string
  size?: 'sm' | 'md' | 'lg'
  iconOnly?: boolean
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void
}

const iconSizes = {
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
  lg: 'h-4 w-4',
}

export function ExplorerLink({
  url,
  label,
  children,
  className,
  size = 'md',
  iconOnly = false,
  onClick,
}: ExplorerLinkProps) {
  const iconSize = iconSizes[size]
  
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className={cn(
        'text-primary hover:text-primary/80 underline flex items-center gap-1',
        iconOnly && 'no-underline',
        className
      )}
      aria-label={label || 'Open in explorer'}
      title={label || 'Open in explorer'}
    >
      {children}
      <ExternalLink className={iconSize} />
    </a>
  )
}
