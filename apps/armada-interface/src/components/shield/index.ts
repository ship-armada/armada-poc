// ABOUTME: Barrel export for the shield (deposit) feature — modal orchestrator + per-step components.
// ABOUTME: ShieldModal is the only export consumed externally; steps are exposed for testability.

export { ShieldModal } from './ShieldModal'

export { ShieldAmountStepContent, ShieldAmountStepFooter } from './ShieldAmountStep'
export type { ShieldTab } from './ShieldAmountStep'

export { ShieldReviewStep } from './ShieldReviewStep'
export type { ShieldReviewStepProps } from './ShieldReviewStep'

export { ShieldCompleteStep } from './ShieldCompleteStep'
export type { ShieldCompleteStepProps } from './ShieldCompleteStep'
