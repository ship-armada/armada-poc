import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/useToast'
import { buildCopySuccessToast } from '@/utils/toastHelpers'

interface CopyButtonProps {
  text: string
  label?: string
  onCopy?: () => void
  size?: 'sm' | 'md' | 'lg'
  className?: string
  showSuccessState?: boolean
  successDuration?: number
}

const iconSizes = {
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
  lg: 'h-4 w-4',
}

export function CopyButton({
  text,
  label,
  onCopy,
  size = 'md',
  className,
  showSuccessState = true,
  successDuration = 2000,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const { notify } = useToast()
  const iconSize = iconSizes[size]

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      
      if (onCopy) {
        onCopy()
      } else {
        notify(buildCopySuccessToast(label || 'Value'))
      }
      
      if (showSuccessState) {
        setTimeout(() => setCopied(false), successDuration)
      }
    } catch (error) {
      console.error('[CopyButton] Failed to copy to clipboard:', error)
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors rounded flex-shrink-0',
        className
      )}
      aria-label={label ? `Copy ${label}` : 'Copy to clipboard'}
      title={label ? `Copy ${label}` : 'Copy to clipboard'}
    >
      {copied ? (
        <Check className={iconSize} />
      ) : (
        <Copy className={iconSize} />
      )}
    </button>
  )
}
