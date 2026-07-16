// ABOUTME: Barrel export for onboarding/unlock primitives — OnboardingShell, OnboardingFlow, UnlockFlow, plus the per-step components.
// ABOUTME: App.tsx imports OnboardingFlow + UnlockFlow; step components are mostly internal to OnboardingFlow.

export { OnboardingShell } from './OnboardingShell'
export type { OnboardingShellProps } from './OnboardingShell'

export { OnboardingFlow } from './OnboardingFlow'
export type { OnboardingFlowProps } from './OnboardingFlow'

export { OnboardingFlowV2 } from './OnboardingFlowV2'
export type { OnboardingFlowV2Props } from './OnboardingFlowV2'

export { OnboardingLayout } from '../OnboardingLayout/OnboardingLayout'
export type { OnboardingLayoutProps } from '../OnboardingLayout/OnboardingLayout'

export { UnlockFlow } from './UnlockFlow'
export type { UnlockFlowProps } from './UnlockFlow'

export { WelcomeStep } from './steps/WelcomeStep'
export type { WelcomeStepProps } from './steps/WelcomeStep'

export { SignEnrollmentStep } from './steps/SignEnrollmentStep'
export type { SignEnrollmentStepProps } from './steps/SignEnrollmentStep'

export { AntiPhishChecksumStep } from './steps/AntiPhishChecksumStep'
export type { AntiPhishChecksumStepProps } from './steps/AntiPhishChecksumStep'

export { BackupPassphraseStep } from './steps/BackupPassphraseStep'
export type { BackupPassphraseStepProps } from './steps/BackupPassphraseStep'

export { ConfirmBackupStep } from './steps/ConfirmBackupStep'
export type { ConfirmBackupStepProps } from './steps/ConfirmBackupStep'

export { CompleteStep } from './steps/CompleteStep'
export type { CompleteStepProps } from './steps/CompleteStep'

export { NonDeterministicSignerScreen } from './NonDeterministicSignerScreen'
export type { NonDeterministicSignerScreenProps } from './NonDeterministicSignerScreen'
