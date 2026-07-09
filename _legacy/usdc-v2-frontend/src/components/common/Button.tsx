import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-primary/40',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-secondary/80 focus-visible:ring-secondary/40',
  ghost: 'bg-transparent text-foreground hover:bg-muted focus-visible:ring-ring/50',
  outline: 'bg-transparent text-foreground border-border hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', type = 'button', disabled, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2',
        variantStyles[variant],
        disabled && 'opacity-50 cursor-not-allowed pointer-events-none',
        className,
      )}
      {...props}
    />
  ),
)

Button.displayName = 'Button'
