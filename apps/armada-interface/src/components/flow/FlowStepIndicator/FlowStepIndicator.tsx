// ABOUTME: Segmented progress indicator for ActionFlowShell — N equal-width ticks, filled up to currentStep.
// ABOUTME: Visual reference: designer's committer mockup ("STEP 1 OF 4" + ticked bar). Brand purple fill on filled segments.

import styles from './FlowStepIndicator.module.css'

export type FlowStepIndicatorStatus = 'default' | 'error' | 'confirmed'

export interface FlowStepIndicatorProps {
  /** 1-based index of the current step. Values outside [1, totalSteps] are clamped. */
  currentStep: number
  /** Total number of steps in the indicator. */
  totalSteps: number
  /** Optional human labels for each step (length should match totalSteps). */
  steps?: string[]
  /** Fixed flow title (e.g. "Deposit") — shown left instead of the active step name. */
  flowLabel?: string
  /** When `confirmed`, all segments use success green (crowdfund Steps parity). */
  status?: FlowStepIndicatorStatus
  className?: string
}

export function FlowStepIndicator({
  currentStep,
  totalSteps,
  steps,
  flowLabel,
  status = 'default',
  className,
}: FlowStepIndicatorProps) {
  const total = Math.max(1, Math.floor(totalSteps))
  const current = Math.max(1, Math.min(total, Math.floor(currentStep)))

  const stepName = flowLabel
    ? flowLabel.toUpperCase()
    : (steps?.[current - 1]?.toUpperCase() ?? '')
  const stepCount =
    status === 'confirmed'
      ? `STEP ${total} OF ${total}`
      : `STEP ${current} OF ${total}`

  const cls = [styles.container, className].filter(Boolean).join(' ')
  return (
    <div
      className={cls}
      role="progressbar"
      aria-label={`Step ${current} of ${total}`}
      aria-valuenow={current}
      aria-valuemin={1}
      aria-valuemax={total}
    >
      <div className={styles.headerRow}>
        <span className={styles.stepName}>{stepName}</span>
        <span className={styles.stepCount}>{stepCount}</span>
      </div>
      <div className={styles.progressBar}>
        {Array.from({ length: total }).map((_, index) => {
          const isActive = index < current
          const segmentClassName = [
            styles.segment,
            status === 'confirmed' && styles.confirmed,
            status === 'error' && isActive && styles.error,
            status === 'default' && isActive && styles.active,
          ]
            .filter(Boolean)
            .join(' ')
          return <div key={index} className={segmentClassName} />
        })}
      </div>
    </div>
  )
}
