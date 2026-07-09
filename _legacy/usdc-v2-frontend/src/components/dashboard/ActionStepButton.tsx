import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ActionStepButtonProps {
  /** Step number to display */
  stepNumber: number
  /** Icon component */
  icon: LucideIcon
  /** Title text */
  title: string
  /** Description text */
  description: string
  /** Link destination (if provided, renders as Link) */
  to?: string
  /** Whether button is disabled */
  disabled?: boolean
  /** Click handler (if no 'to' prop) */
  onClick?: () => void
  /** Additional className */
  className?: string
  /** Border radius classes */
  borderRadius?: {
    top?: string
    bottom?: string
  }
}

/**
 * Reusable action step button component with consistent styling
 * 
 * Can render as either a Link (if 'to' prop provided) or button (if onClick provided).
 * Used for deposit, shield, and send action buttons.
 */
export function ActionStepButton({
  stepNumber,
  icon: Icon,
  title,
  description,
  to,
  disabled = false,
  onClick,
  className,
  borderRadius = {},
}: ActionStepButtonProps) {
  const baseClasses = cn(
    "group flex items-center gap-4 p-8 bg-card hover:bg-muted transition-colors",
    disabled && "opacity-50 cursor-not-allowed",
    className,
  )

  const content = (
    <>
      <span className="flex justify-center items-center mr-4 text-md bg-muted-foreground/10 w-8 h-8 rounded-full font-semibold text-muted-foreground group-hover:text-foreground transition-colors">
        {stepNumber}
      </span>
      <Icon className="h-5 w-5 text-foreground group-hover:text-primary flex-shrink-0 transition-colors" />
      <div className="flex flex-col gap-0.5 flex-1">
        <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
          {title}
        </p>
        <p className="text-xs text-muted-foreground group-hover:text-foreground">
          {description}
        </p>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary flex-shrink-0 transition-colors" />
    </>
  )

  if (to) {
    return (
      <Link
        to={disabled ? "#" : to}
        className={cn(
          baseClasses,
          borderRadius.top && borderRadius.top,
          borderRadius.bottom && borderRadius.bottom,
        )}
        onClick={(e) => {
          if (disabled) {
            e.preventDefault()
          }
          onClick?.()
        }}
      >
        {content}
      </Link>
    )
  }

  return (
    <button
      className={cn(
        baseClasses,
        borderRadius.top && borderRadius.top,
        borderRadius.bottom && borderRadius.bottom,
        "text-left w-full",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {content}
    </button>
  )
}
