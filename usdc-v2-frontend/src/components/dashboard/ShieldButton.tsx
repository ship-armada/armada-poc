import { Shield } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { cn } from '@/lib/utils'

export interface ShieldButtonProps {
  /** Whether the button is disabled */
  disabled: boolean
  /** Whether shielded balance is loading */
  loading?: boolean
  /** Click handler */
  onClick: () => void
  /** Button variant */
  variant?: 'inline' | 'action-step'
  /** Tooltip title text */
  title?: string
  /** Additional className */
  className?: string
}

/**
 * Unified shield button component with consistent disabled states and tooltips
 * 
 * Used in both the balance card (inline) and action steps section.
 */
export function ShieldButton({
  disabled,
  loading = false,
  onClick,
  variant = 'inline',
  title,
  className,
}: ShieldButtonProps) {
  if (variant === 'action-step') {
    return (
      <button
        className={cn(
          "flex items-center gap-4 p-8 rounded-none bg-card hover:bg-muted transition-colors text-left w-full",
          "group",
          (loading || disabled) && "opacity-50 cursor-not-allowed",
          className,
        )}
        onClick={onClick}
        disabled={disabled || loading}
        title={title}
      >
        <span className="flex justify-center items-center mr-4 text-md bg-muted-foreground/10 w-8 h-8 rounded-full font-semibold text-muted-foreground group-hover:text-foreground transition-colors">2</span>
        <Shield className="h-5 w-5 text-foreground group-hover:text-primary flex-shrink-0 transition-colors" />
        <div className="flex flex-col gap-0.5 flex-1">
          <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">Shield</p>
          <p className="text-xs text-muted-foreground group-hover:text-foreground">Move USDC to your shielded balance</p>
        </div>
      </button>
    )
  }

  // Inline variant (for balance card)
  return (
    <Button
      variant="ghost"
      className={cn(
        "h-7 px-3 text-xs text-accent-foreground gap-1.5 border-none bg-accent/40 hover:bg-accent/30",
        (loading || disabled) && "opacity-50 cursor-not-allowed",
        className,
      )}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
    >
      <Shield className="h-3.5 w-3.5" />
      Shield Now
    </Button>
  )
}
