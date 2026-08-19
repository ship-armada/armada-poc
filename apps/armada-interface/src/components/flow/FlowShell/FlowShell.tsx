// ABOUTME: FlowShell — action-flow modal chrome wrapping the vendored FlowModalOverlay + ModalShell.
// ABOUTME: Replaces DepositOverlayShell for the redesigned flows; renders the logo + Steps progress + close + backdrop/focus-trap.

import type { ReactNode } from 'react'
import { FlowModalOverlay, ModalShell, ModalStepSwitch } from '@/design'
import styles from './FlowShell.module.css'

/** Default 3-step deposit/action progress labels (Amount → Review → Confirm). */
const DEFAULT_STEPS = ['Amount', 'Review', 'Confirm']

export interface FlowShellProps {
  open: boolean
  onClose: () => void
  flowLabel?: string
  steps?: string[]
  /** 1-based active step. */
  currentStep: number
  status?: 'default' | 'confirmed' | 'error'
  /** Hide the step-progress bar (e.g. the standalone activity receipt, which isn't a live flow). */
  hideSteps?: boolean
  /** Play the close (slide-down) animation. The caller keeps `open` true until the exit completes. */
  exiting?: boolean
  /**
   * Current step identifier. When it changes, ModalStepSwitch plays a short content exit then
   * remounts the new step so its enter animations replay. Omit for static shells (e.g. the receipt).
   */
  stepKey?: string
  children: ReactNode
}

export function FlowShell({
  open,
  onClose,
  flowLabel = 'Deposit',
  steps = DEFAULT_STEPS,
  currentStep,
  status = 'default',
  hideSteps = false,
  exiting = false,
  stepKey,
  children,
}: FlowShellProps) {
  if (!open && !exiting) return null

  return (
    <FlowModalOverlay label={flowLabel} exiting={exiting} onClose={onClose}>
      <ModalShell
        steps={steps}
        currentStep={currentStep}
        status={status}
        hideSteps={hideSteps}
        exiting={exiting}
        flowLabel={flowLabel}
        onClose={onClose}
      >
        {/* The .stepColumn (436px column + inter-element gap) lives INSIDE ModalStepSwitch so it
            plays the role of the mockup's `modalStepShell`: ModalStepSwitch's own `.stepShell`
            wrapper only centers + animates, so the column layout must wrap the content, not the
            switch — otherwise the gap + width never reach the card/buttons. */}
        {stepKey !== undefined ? (
          <ModalStepSwitch stepKey={stepKey} skipExit={exiting}>
            <div className={styles.stepColumn}>{children}</div>
          </ModalStepSwitch>
        ) : (
          <div className={styles.stepColumn}>{children}</div>
        )}
      </ModalShell>
    </FlowModalOverlay>
  )
}
