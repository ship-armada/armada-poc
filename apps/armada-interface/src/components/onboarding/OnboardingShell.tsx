// ABOUTME: Onboarding/unlock page-level shell — non-dismissible Modal with FlowHeader chrome around the body content.
// ABOUTME: Used by OnboardingFlow (5-step first-run) and UnlockFlow (single-screen passphrase). Step indicator visibility is controlled by the caller.

import type { ReactNode } from 'react'
import { Modal } from '../ui/Modal'
import { FlowHeader } from '../flow/FlowHeader'
import type { FlowStepIndicatorStatus } from '../flow/FlowStepIndicator'
import styles from './OnboardingShell.module.css'

export interface OnboardingShellProps {
  title: string
  /** 1-based index of the current step; ignored when showIndicator=false. */
  currentStep: number
  /** Total step count; ignored when showIndicator=false. */
  totalSteps: number
  /** Optional human labels for each step in the indicator. */
  steps?: string[]
  /** When `confirmed`, progress segments render success green (final onboarding step). */
  indicatorStatus?: FlowStepIndicatorStatus
  /** Whether to render the step indicator beneath the title. Default true. UnlockFlow passes false. */
  showIndicator?: boolean
  /** Rendered below the modal card (outside the bordered container). */
  below?: ReactNode
  children: ReactNode
}

export function OnboardingShell({
  title,
  currentStep,
  totalSteps,
  steps,
  indicatorStatus,
  showIndicator = true,
  below,
  children,
}: OnboardingShellProps) {
  // Onboarding/unlock are never user-dismissible — passing dismissible=false hides the close button
  // and ignores ESC + backdrop click. onClose is a no-op for the same reason.
  return (
    <Modal
      open
      onClose={() => {}}
      dismissible={false}
      ariaLabel={title}
      wrapBody={false}
      dialogClassName={styles.dialog}
      belowDialog={below}
    >
      {showIndicator ? (
        <FlowHeader
          title=""
          currentStep={currentStep}
          totalSteps={totalSteps}
          steps={steps}
          indicatorStatus={indicatorStatus}
          showIndicator
          className={styles.header}
        />
      ) : null}
      <div className={styles.body}>{children}</div>
    </Modal>
  )
}
