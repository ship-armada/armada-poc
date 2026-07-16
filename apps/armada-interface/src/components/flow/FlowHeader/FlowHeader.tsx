// ABOUTME: ActionFlowShell header — title + close button row, with the FlowStepIndicator below.
// ABOUTME: Close button is hidden when the flow is in a non-dismissible step (e.g. progress); consumers force-show via showCloseButton.

import { X } from 'lucide-react'
import { FlowStepIndicator, type FlowStepIndicatorStatus } from '../FlowStepIndicator'
import styles from './FlowHeader.module.css'

export interface FlowHeaderProps {
  title: string
  /** 1-based index of the current step shown in the indicator. Ignored when showIndicator=false. */
  currentStep: number
  /** Total number of steps shown in the indicator. Ignored when showIndicator=false. */
  totalSteps: number
  /** Optional step labels for the indicator. */
  steps?: string[]
  /** Passed through to FlowStepIndicator — `confirmed` fills all segments green. */
  indicatorStatus?: FlowStepIndicatorStatus
  /** Whether to render the step indicator beneath the title. Defaults true. Pass false for the error step overlay. */
  showIndicator?: boolean
  /** Called when the close button is clicked. Required when showCloseButton is true. */
  onClose?: () => void
  /** Whether to render the X close button. */
  showCloseButton?: boolean
  /** Optional id to wire the title element to an aria-labelledby attribute on the dialog. */
  titleId?: string
  className?: string
}

export function FlowHeader({
  title,
  currentStep,
  totalSteps,
  steps,
  indicatorStatus,
  showIndicator = true,
  onClose,
  showCloseButton = false,
  titleId,
  className,
}: FlowHeaderProps) {
  const cls = [styles.root, className].filter(Boolean).join(' ')
  const showTitleRow = Boolean(title) || showCloseButton
  return (
    <header className={cls}>
      {showTitleRow ? (
        <div className={styles.titleRow}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {showCloseButton ? (
            <button
              type="button"
              className={styles.close}
              onClick={onClose}
              aria-label="Close"
            >
              <X size={18} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {showIndicator ? (
        <FlowStepIndicator
          currentStep={currentStep}
          totalSteps={totalSteps}
          steps={steps}
          status={indicatorStatus}
        />
      ) : null}
    </header>
  )
}
