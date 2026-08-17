// ABOUTME: FlowShell — action-flow modal chrome wrapping the vendored FlowModalOverlay + ModalShell.
// ABOUTME: Replaces DepositOverlayShell for the redesigned flows; renders the logo + Steps progress + close + backdrop/focus-trap.

import type { ReactNode } from 'react'
import { FlowModalOverlay, ModalShell } from '@/design'
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
  children: ReactNode
}

export function FlowShell({
  open,
  onClose,
  flowLabel = 'Deposit',
  steps = DEFAULT_STEPS,
  currentStep,
  status = 'default',
  children,
}: FlowShellProps) {
  if (!open) return null

  return (
    <FlowModalOverlay label={flowLabel} onClose={onClose}>
      <ModalShell
        steps={steps}
        currentStep={currentStep}
        status={status}
        flowLabel={flowLabel}
        onClose={onClose}
      >
        <div className={styles.stepColumn}>{children}</div>
      </ModalShell>
    </FlowModalOverlay>
  )
}
