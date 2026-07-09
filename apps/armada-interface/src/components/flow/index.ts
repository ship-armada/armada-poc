// ABOUTME: Barrel export for flow primitives — ActionFlowShell, FlowStepIndicator, FlowHeader, FlowFooter, ProgressStep, ErrorStep.
// ABOUTME: Re-exports each component plus its prop types. Add a line here when a new flow primitive lands.

export { ActionFlowShell } from './ActionFlowShell'
export type {
  ActionFlowShellProps,
  FlowStep,
  FlowVisibleStep,
} from './ActionFlowShell'

export { FlowStepIndicator } from './FlowStepIndicator'
export type { FlowStepIndicatorProps } from './FlowStepIndicator'

export { FlowHeader } from './FlowHeader'
export type { FlowHeaderProps } from './FlowHeader'

export { FlowFooter } from './FlowFooter'
export type { FlowFooterProps, FlowAction } from './FlowFooter'

export { ProgressStep } from './ProgressStep'
export type { ProgressStepProps } from './ProgressStep'

export { ErrorStep } from './ErrorStep'
export type { ErrorStepProps } from './ErrorStep'

export {
  OVERLAY_STEP_LABELS,
  overlayIndicatorStep,
  overlayIndicatorStatus,
} from './overlayFlow'
