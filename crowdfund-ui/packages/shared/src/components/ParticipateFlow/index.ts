// ABOUTME: Barrel for the ParticipateFlow multi-step screens and modal shell.
// ABOUTME: Re-exports each step (Step0Invite + Step1–Step5) plus the modal + invite-slots step used by the Path 2 hero-entry flow.

export { default as Step0Invite } from './steps/Step0Invite/Step0Invite'
export type { Step0InviteProps } from './steps/Step0Invite/Step0Invite'
export { default as Step1Wallet } from './screens/Step1Wallet'
export { default as Step1Connect } from './screens/Step1Connect'
export { default as Step1SwitchNetwork } from './screens/Step1SwitchNetwork'
export { default as Step1WalletNotWhitelisted } from './screens/Step1WalletNotWhitelisted'
export { default as Step2Commit, MaxOutBanner } from './screens/Step2Commit'
export type { Step2CommitHopRow, Step2MaxOutOption } from './screens/Step2Commit'
export { default as Step3Review } from './screens/Step3Review'
export type { Step3ReviewHopCommit } from './screens/Step3Review'
export { default as Step4Approve } from './screens/Step4Approve'
export type {
  Step4ApproveProps,
  Transaction as Step4Transaction,
  TransactionStatus as Step4TransactionStatus,
} from './screens/Step4Approve'
export { default as Step5Confirmation } from './screens/Step5Confirmation'

export {
  INVITE_LINK_STEPS,
  CROWDFUND_MODAL_STEPS,
} from './participateFlowSteps'
export type {
  ParticipateStepsStatus,
  ParticipateStepBarProps,
} from './participateFlowSteps'

export { ParticipateFlowModal } from './ParticipateFlowModal'
export type { ParticipateFlowModalProps } from './ParticipateFlowModal'

export { ParticipateFlowInviteSlots } from './ParticipateFlowInviteSlots'
export type { ParticipateFlowInviteSlotsProps } from './ParticipateFlowInviteSlots'
