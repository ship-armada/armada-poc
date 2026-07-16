// ABOUTME: Shared 3-step overlay flow mapping — Amount / Review / Confirm (progress + complete = step 3).

import type { FlowStep } from './ActionFlowShell/ActionFlowShell'
import type { FlowStepIndicatorStatus } from './FlowStepIndicator'

export const OVERLAY_STEP_LABELS = ['Amount', 'Review', 'Confirm'] as const

/** Map flow step to 1-based index for the 3-segment bar (Confirm covers progress + complete). */
export function overlayIndicatorStep(step: FlowStep): number {
  switch (step) {
    case 'input':
      return 1
    case 'review':
      return 2
    case 'progress':
    case 'complete':
    case 'error':
      return 3
    default:
      return 1
  }
}

export function overlayIndicatorStatus(step: FlowStep): FlowStepIndicatorStatus {
  if (step === 'complete') return 'confirmed'
  if (step === 'error') return 'error'
  return 'default'
}
