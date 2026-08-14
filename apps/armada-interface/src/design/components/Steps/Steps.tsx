// ABOUTME: Progress indicator for multi-step flows — step name/count header row plus a segmented progress bar.
// ABOUTME: Ported from the armada-app design mockup.
import styles from './Steps.module.css'

export interface StepsProps {
  steps: string[]
  currentStep: number
  status?: 'default' | 'error' | 'confirmed'
  /** Fixed flow title (e.g. "Deposit") — when set, shown left instead of the active step name. */
  flowLabel?: string
  hideStepCount?: boolean
}

export function Steps({
  steps,
  currentStep,
  status = 'default',
  flowLabel,
  hideStepCount = false,
}: StepsProps) {
  const stepName = flowLabel
    ? flowLabel.toUpperCase()
    : status === 'confirmed'
      ? 'CONFIRMATION'
      : (steps[currentStep - 1]?.toUpperCase() ?? '')
  const stepCount =
    status === 'confirmed'
      ? `STEP ${steps.length} OF ${steps.length}`
      : `STEP ${currentStep} OF ${steps.length}`

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <span className={styles.stepName}>{stepName}</span>
        {hideStepCount ? null : <span className={styles.stepCount}>{stepCount}</span>}
      </div>
      <div className={styles.progressBar}>
        {steps.map((_, index) => {
          const isActive = index < currentStep
          const className = [
            styles.segment,
            status === 'confirmed' && styles.confirmed,
            status === 'error' && isActive && styles.error,
            status === 'default' && isActive && styles.active,
          ]
            .filter(Boolean)
            .join(' ')

          return <div key={index} className={className} />
        })}
      </div>
    </div>
  )
}
