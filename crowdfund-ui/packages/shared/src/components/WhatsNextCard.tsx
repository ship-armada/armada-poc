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
  className,
}: WhatsNextCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card/70 p-4 text-sm backdrop-blur-sm',
        className,
      )}
    >
      <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <ol className="space-y-2.5">
        {steps.map((step, i) => {
          const status = step.status ?? 'pending'
          return (
            <li key={i} className="flex items-start gap-2.5">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                <StatusIcon status={status} />
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    status === 'done' && 'text-muted-foreground line-through decoration-muted-foreground/40',
                    status === 'active' && 'text-foreground font-medium',
                    status === 'pending' && 'text-foreground',
                  )}
                >
                  {step.label}
                </div>
                {step.detail && (
                  <div className="mt-0.5 text-xs text-muted-foreground">{step.detail}</div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
