// ABOUTME: Multi-step progress indicator — header row (step name + count) over a segmented bar.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; props interface promoted to `export` so consumers can import the type.

import styles from './Steps.module.css'

export interface StepsProps {
  steps: string[]
  currentStep: number
  status?: 'default' | 'error' | 'confirmed'
}

export default function Steps({ steps, currentStep, status = 'default' }: StepsProps) {
  const stepName =
    status === 'confirmed' ? 'CONFIRMATION' : (steps[currentStep - 1]?.toUpperCase() ?? '')
  const stepCount =
    status === 'confirmed'
      ? `STEP ${steps.length} OF ${steps.length}`
      : `STEP ${currentStep} OF ${steps.length}`

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <span className={styles.stepName}>{stepName}</span>
        <span className={styles.stepCount}>{stepCount}</span>
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
