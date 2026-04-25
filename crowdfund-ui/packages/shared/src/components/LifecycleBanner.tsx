// ABOUTME: Persistent campaign lifecycle indicator — Commit & Invite → Claim → Complete.
// ABOUTME: Shown at the top of committer pages so phase transitions stay legible.

import { Check } from 'lucide-react'
import { cn } from '../lib/utils.js'
import { formatCountdown } from '../lib/format.js'

/**
 * Lifecycle stage of the crowdfund. The banner highlights one stage at a
 * time and marks earlier stages complete.
 *  - `commit-invite` — phase 0 with the commitment window still open
 *  - `claim`         — phase 1 (finalized) or phase 2 (cancelled), or phase 0
 *                      after windowEnd has passed (refund eligibility window)
 *  - `complete`      — claim deadline has passed
 */
export type LifecycleStage = 'commit-invite' | 'claim' | 'complete'

export interface LifecycleBannerProps {
  /** Current stage. Caller derives this from contract state. */
  stage: LifecycleStage
  /** Optional countdown shown beside the active stage label. */
  countdownSeconds?: number
  /** Optional override label for the right-side hint (e.g. "Claim is now live"). */
  hint?: string
  /** Compact inline rendering for embedding in a header bar.
   *  Drops the card chrome and per-step labels — just a mini stepper + the
   *  active stage label + countdown, in a single line. */
  compact?: boolean
  className?: string
}

interface StepDef {
  id: LifecycleStage
  label: string
}

const STEPS: ReadonlyArray<StepDef> = [
  { id: 'commit-invite', label: 'Commit & Invite' },
  { id: 'claim', label: 'Claim' },
  { id: 'complete', label: 'Complete' },
]

function stepStatus(step: LifecycleStage, current: LifecycleStage): 'done' | 'active' | 'pending' {
  const order: LifecycleStage[] = ['commit-invite', 'claim', 'complete']
  const ci = order.indexOf(current)
  const si = order.indexOf(step)
  if (si < ci) return 'done'
  if (si === ci) return 'active'
  return 'pending'
}

/** Default hint text per stage when no explicit `hint` is supplied. */
function defaultHint(stage: LifecycleStage, countdownSeconds?: number): string {
  switch (stage) {
    case 'commit-invite':
      if (countdownSeconds !== undefined && countdownSeconds > 0) {
        return `Ends in ${formatCountdown(countdownSeconds)}`
      }
      return 'Window open'
    case 'claim':
      return 'Claim is now live'
    case 'complete':
      return 'Campaign complete'
  }
}

export function LifecycleBanner({
  stage,
  countdownSeconds,
  hint,
  compact,
  className,
}: LifecycleBannerProps) {
  const resolvedHint = hint ?? defaultHint(stage, countdownSeconds)
  const activeLabel = STEPS.find((s) => s.id === stage)?.label ?? ''

  if (compact) {
    // Inline form designed to fit inside the AppShell header bar. Renders
    // as: [● — ○ — ○]  ActiveLabel · 13d 4h  — no card chrome, ~250px wide.
    return (
      <div
        className={cn(
          'flex items-center gap-2 text-xs whitespace-nowrap',
          className,
        )}
        aria-label="Campaign lifecycle"
      >
        <ol className="flex items-center">
          {STEPS.map((step, i) => {
            const status = stepStatus(step.id, stage)
            return (
              <li key={step.id} className="flex items-center">
                <span
                  className={cn(
                    'block size-2.5 rounded-full border',
                    status === 'done' && 'border-primary bg-primary',
                    status === 'active' &&
                      'border-primary bg-primary/30 shadow-[0_0_0_2px] shadow-primary/25',
                    status === 'pending' && 'border-border bg-transparent',
                  )}
                  aria-hidden="true"
                />
                {i < STEPS.length - 1 && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mx-1 h-px w-3',
                      status === 'done' ? 'bg-primary/60' : 'bg-border',
                    )}
                  />
                )}
              </li>
            )
          })}
        </ol>
        <span className="font-medium text-foreground">{activeLabel}</span>
        <span className="text-muted-foreground tabular-nums">· {resolvedHint}</span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card/70 px-4 py-3 backdrop-blur-sm',
        'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
      aria-label="Campaign lifecycle"
    >
      <ol className="flex items-center gap-2 text-sm">
        {STEPS.map((step, i) => {
          const status = stepStatus(step.id, stage)
          return (
            <li key={step.id} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border text-[10px] font-medium tabular-nums',
                  status === 'done' && 'border-primary bg-primary text-primary-foreground',
                  status === 'active' &&
                    'border-primary bg-primary/15 text-primary shadow-[0_0_0_3px] shadow-primary/15',
                  status === 'pending' && 'border-border bg-transparent text-muted-foreground',
                )}
                aria-hidden="true"
              >
                {status === 'done' ? <Check className="size-3" /> : i + 1}
              </span>
              <span
                className={cn(
                  'whitespace-nowrap',
                  status === 'active' ? 'text-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                {step.label}
              </span>
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'mx-1 hidden h-px w-6 sm:inline-block',
                    status === 'done' ? 'bg-primary/60' : 'bg-border',
                  )}
                />
              )}
            </li>
          )
        })}
      </ol>
      <div className="text-xs text-muted-foreground tabular-nums">{resolvedHint}</div>
    </div>
  )
}
