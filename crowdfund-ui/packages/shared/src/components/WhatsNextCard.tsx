// ABOUTME: Small "What happens next?" list card used after commit and on the Claim page.
// ABOUTME: Renders an ordered list of steps; each step can be marked done / active / pending.

import type { ReactNode } from 'react'
import { Check, Circle, Dot } from 'lucide-react'
import { cn } from '../lib/utils.js'

export type WhatsNextStepStatus = 'done' | 'active' | 'pending'

export interface WhatsNextStep {
  label: ReactNode
  /** Optional helper text rendered under the label. */
  detail?: ReactNode
  status?: WhatsNextStepStatus
}

export interface WhatsNextCardProps {
  /** Card heading. Defaults to "What happens next?" */
  title?: ReactNode
  steps: WhatsNextStep[]
  /** Compact rail presentation for contextual help beside the main flow. */
  variant?: 'card' | 'rail'
  className?: string
}

function StatusIcon({ status }: { status: WhatsNextStepStatus }) {
  if (status === 'done')
    return <Check className="size-3.5 text-primary" aria-hidden="true" />
  if (status === 'active')
    return <Dot className="size-5 -m-1 text-primary" aria-hidden="true" />
  return <Circle className="size-3 text-muted-foreground/50" aria-hidden="true" />
}

export function WhatsNextCard({
  title = 'What happens next?',
  steps,
  variant = 'card',
  className,
}: WhatsNextCardProps) {
  const isRail = variant === 'rail'

  return (
    <div
      className={cn(
        isRail
          ? 'rounded-md border border-border/45 bg-background/25 p-3 text-xs text-muted-foreground backdrop-blur-sm'
          : 'rounded-lg border border-border bg-card/70 p-4 text-sm backdrop-blur-sm',
        className,
      )}
    >
      <div
        className={cn(
          isRail
            ? 'mb-2 text-[11px] font-medium text-muted-foreground'
            : 'mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground',
        )}
      >
        {title}
      </div>
      <ol className={cn(isRail ? 'space-y-2' : 'space-y-2.5')}>
        {steps.map((step, i) => {
          const status = step.status ?? 'pending'
          return (
            <li key={i} className={cn('flex items-start', isRail ? 'gap-2' : 'gap-2.5')}>
              <span
                className={cn(
                  'mt-0.5 flex shrink-0 items-center justify-center',
                  isRail ? 'size-3.5 opacity-80' : 'size-4',
                )}
              >
                <StatusIcon status={status} />
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    status === 'done' && 'text-muted-foreground line-through decoration-muted-foreground/40',
                    status === 'active' && (isRail ? 'font-medium text-foreground/85' : 'text-foreground font-medium'),
                    status === 'pending' && (isRail ? 'text-muted-foreground' : 'text-foreground'),
                  )}
                >
                  {step.label}
                </div>
                {step.detail && (
                  <div className={cn('mt-0.5 text-muted-foreground', isRail ? 'text-[11px]' : 'text-xs')}>
                    {step.detail}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
