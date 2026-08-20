// ABOUTME: Barrel export for the account-entry primitives — SignInFlow (the live single sign-in), plus OnboardingShell + the dead V1 OnboardingFlow and its per-step components.
// ABOUTME: App.tsx imports SignInFlow; the step components are consumed only by the dead V1 OnboardingFlow.

export { OnboardingShell } from './OnboardingShell'
export type { OnboardingShellProps } from './OnboardingShell'

export { OnboardingFlow } from './OnboardingFlow'
export type { OnboardingFlowProps } from './OnboardingFlow'

export { OnboardingLayout } from '../OnboardingLayout/OnboardingLayout'
export type { OnboardingLayoutProps } from '../OnboardingLayout/OnboardingLayout'

export { SignInFlow } from './SignInFlow'
export type { SignInFlowProps } from './SignInFlow'

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
