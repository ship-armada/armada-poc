// ABOUTME: Visual chrome for multi-step "checkout" flows with numbered progress dots.
// ABOUTME: Steps own their own back/next chrome via the StepFooter helper exported below.

import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../lib/utils.js'
import { Button } from './ui/button.js'

export interface StepperStep {
  id: string
  /** Label used for accessible progress state and compact step labels. */
  label: string
}

export interface StepperProps {
  steps: ReadonlyArray<StepperStep>
  /** Zero-based index of the active step. */
  current: number
  children: ReactNode
  className?: string
}

/**
 * Stepper renders a header dot row above the step body. The body is filled by
 * `children` — typically one step at a time, gated by the consumer on
 * `current`. Step content is responsible for its own Back / Next chrome (see
 * `StepFooter`).
 */
export function Stepper({ steps, current, children, className }: StepperProps) {
  const safeCurrent = Math.max(0, Math.min(current, steps.length - 1))
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border/80 bg-card/80 shadow-elevated backdrop-blur-sm',
        'ring-1 ring-white/[0.03]',
        className,
      )}
    >
      <div className="border-b border-border/65 bg-background/25 px-5 py-4">
        <ol
          role="list"
          aria-label="Checkout progress"
          className="mx-auto flex max-w-md items-start justify-center"
        >
          {steps.map((step, i) => {
            const status =
              i < safeCurrent ? 'done' : i === safeCurrent ? 'active' : 'pending'
            return (
              <li key={step.id} className="flex min-w-0 flex-1 items-start last:flex-none">
                <div className="flex min-w-10 flex-col items-center gap-1.5">
                  <span
                    className={cn(
                      'flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums transition-all',
                      status === 'done' &&
                        'border-primary/70 bg-primary/20 text-primary shadow-[0_0_16px_rgba(83,224,224,0.12)]',
                      status === 'active' &&
                        'border-hop-0 bg-hop-0/90 text-white shadow-[0_0_0_4px] shadow-hop-0/20',
                      status === 'pending' &&
                        'border-border/80 bg-background/50 text-muted-foreground',
                    )}
                    aria-current={status === 'active' ? 'step' : undefined}
                    aria-label={step.label}
                  >
                    {i + 1}
                  </span>
                  <span
                    className={cn(
                      'hidden max-w-20 truncate text-center text-[10px] leading-none sm:block',
                      status === 'active' ? 'text-foreground' : 'text-muted-foreground/70',
                    )}
                  >
                    {step.label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-2.5 h-px flex-1',
                      i < safeCurrent ? 'bg-primary/60' : 'bg-border/80',
                    )}
                  />
                )}
              </li>
            )
          })}
        </ol>
      </div>
      <div className="px-6 py-6">{children}</div>
    </div>
  )
}

export interface StepFooterProps {
  /** Called when the Back button is clicked. Omitting hides the button. */
  onBack?: () => void
  /** Called when the primary (Next/Confirm) button is clicked. */
  onNext?: () => void
  backLabel?: string
  nextLabel?: string
  nextDisabled?: boolean
  /** When true the primary button shows a spinner and disables. */
  nextLoading?: boolean
  /** Use the destructive primary variant (red). For "Confirm cancel" cases. */
  destructive?: boolean
  /** Variant of the primary button. Defaults to filled `default`. */
  nextVariant?: 'default' | 'outline' | 'secondary'
  /** Optionally hide the primary button entirely (e.g. terminal-error step). */
  hideNext?: boolean
  className?: string
}

/**
 * Standard Back / Next chrome at the bottom of a step body. Each step renders
 * its own footer so it can gate the primary button on local validation. The
 * back button hides automatically when no `onBack` is provided.
 */
export function StepFooter({
  onBack,
  onNext,
  backLabel = 'Back',
  nextLabel = 'Continue',
  nextDisabled,
  nextLoading,
  destructive,
  nextVariant = 'default',
  hideNext,
  className,
}: StepFooterProps) {
  return (
    <div className={cn('mt-6 flex items-center gap-3 border-t border-border/50 pt-4', className)}>
      {onBack && (
        <Button
          type="button"
          variant="outline"
          className="h-9 rounded-[4px] border-border/70 bg-background/25 px-5 text-xs text-muted-foreground hover:bg-card/80 hover:text-foreground"
          onClick={() => onBack()}
          disabled={nextLoading}
        >
          {backLabel}
        </Button>
      )}
      {!hideNext && (
        <Button
          type="button"
          variant={destructive ? 'destructive' : nextVariant}
          className={cn(
            'ml-auto h-9 rounded-[4px] px-6 text-xs font-semibold',
            !destructive &&
              nextVariant === 'default' &&
              'bg-hop-0/75 text-white shadow-[0_0_18px_rgba(132,80,210,0.14)] hover:bg-hop-0/85',
          )}
          onClick={() => onNext?.()}
          disabled={nextDisabled || nextLoading}
        >
          {nextLoading && <Loader2 className="size-4 animate-spin" />}
          {nextLabel}
        </Button>
      )}
    </div>
  )
}
