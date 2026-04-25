// ABOUTME: Visual chrome for multi-step "checkout" flows — header pill row + step caption.
// ABOUTME: Steps own their own back/next chrome via the StepFooter helper exported below.

import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../lib/utils.js'
import { Button } from './ui/button.js'

export interface StepperStep {
  id: string
  /** Caption shown beneath the body (e.g. "Choose entry"). */
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
 * Stepper renders a header dot row above the step body and a "STEP N · label"
 * caption strip below. The body is filled by `children` — typically one step
 * at a time, gated by the consumer on `current`. Step content is responsible
 * for its own Back / Next chrome (see `StepFooter`).
 */
export function Stepper({ steps, current, children, className }: StepperProps) {
  const safeCurrent = Math.max(0, Math.min(current, steps.length - 1))
  const currentStep = steps[safeCurrent]
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card shadow-elevated overflow-hidden',
        className,
      )}
    >
      <ol
        role="list"
        aria-label="Checkout progress"
        className="flex items-center justify-center gap-1.5 border-b border-border/60 bg-card/40 px-6 py-3"
      >
        {steps.map((step, i) => {
          const status =
            i < safeCurrent ? 'done' : i === safeCurrent ? 'active' : 'pending'
          return (
            <li key={step.id} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'block size-2 rounded-full transition-colors',
                  status === 'done' && 'bg-primary',
                  status === 'active' &&
                    'bg-primary scale-125 shadow-[0_0_0_3px] shadow-primary/20',
                  status === 'pending' && 'bg-border',
                )}
                aria-current={status === 'active' ? 'step' : undefined}
                aria-label={step.label}
              />
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-px w-4',
                    status === 'done' ? 'bg-primary/60' : 'bg-border',
                  )}
                />
              )}
            </li>
          )
        })}
      </ol>
      <div className="px-6 py-5">{children}</div>
      <div className="border-t border-border/60 bg-muted/20 px-6 py-2 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
        Step {safeCurrent + 1} <span className="opacity-50">·</span>{' '}
        {currentStep?.label}
      </div>
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
    <div className={cn('mt-6 flex items-center gap-3', className)}>
      {onBack && (
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={nextLoading}
        >
          {backLabel}
        </Button>
      )}
      {!hideNext && (
        <Button
          type="button"
          variant={destructive ? 'destructive' : nextVariant}
          className="ml-auto"
          onClick={onNext}
          disabled={nextDisabled || nextLoading}
        >
          {nextLoading && <Loader2 className="size-4 animate-spin" />}
          {nextLabel}
        </Button>
      )}
    </div>
  )
}
