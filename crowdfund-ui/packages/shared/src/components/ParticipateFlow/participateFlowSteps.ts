// ABOUTME: Shared step-bar definitions consumed by Step2–Step5 of the Participate flow (Path 1 invite-link, Path 2 hero modal).
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup (ParticipateFlow/participateFlowSteps.ts).

/** Path 1 (invite link): connect is the first counted bar step. */
export const INVITE_LINK_STEPS = ['Connect', 'Commit', 'Review', 'Confirm'] as const

/** Path 2 / 3 (crowdfund modal): bar starts at commit. */
export const CROWDFUND_MODAL_STEPS = ['Commit', 'Review', 'Confirm'] as const

export type ParticipateStepsStatus = 'default' | 'error' | 'confirmed'

export interface ParticipateStepBarProps {
  steps?: readonly string[]
  stepIndex?: number
  stepsStatus?: ParticipateStepsStatus
}
