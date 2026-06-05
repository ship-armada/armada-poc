// ABOUTME: First-run onboarding in the split-panel layout (OnboardingLayout). Same steps as OnboardingFlow — original flow unchanged.
// ABOUTME: Drives useShieldedWallet().enroll() at the Sign step; the resulting root_secret lives in the keyManager (never in component state) and its checksum flows through atoms.

import { useState } from 'react'
import { FlowStepIndicator } from '@/components/flow/FlowStepIndicator'
import { OnboardingLayout } from '@/components/OnboardingLayout/OnboardingLayout'
import { WelcomeStep } from './steps/WelcomeStep'
import { SignEnrollmentStep } from './steps/SignEnrollmentStep'
import { AntiPhishChecksumStep } from './steps/AntiPhishChecksumStep'
import { BackupPassphraseStep } from './steps/BackupPassphraseStep'
import { ConfirmBackupStep } from './steps/ConfirmBackupStep'
import { CompleteStep } from './steps/CompleteStep'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import flowStyles from './OnboardingFlowV2.module.css'

type Step = 'welcome' | 'sign' | 'checksum' | 'backup' | 'confirm-backup' | 'complete'

const STEP_INDEX: Record<Step, number> = {
  welcome: 0,
  sign: 1,
  checksum: 2,
  backup: 3,
  'confirm-backup': 4,
  complete: 5,
}

const TOTAL_STEPS = 5
const STEP_LABELS = [
  'Set up account',
  'Set up account',
  'Set up account',
  'Set up account',
  'Set up account',
] as const

export interface OnboardingFlowV2Props {
  /** Called when the user clicks Done on the final step. Parent should swap App-level mode to "app". */
  onDone: () => void
  /**
   * Optional escape hatch on the Welcome step — switches to the restore-from-backup flow. Parent
   * supplies this when the user is on first-run-onboarding but might already have a wallet
   * (e.g. new device or cleared storage).
   */
  onRestore?: () => void
}

export function OnboardingFlowV2({ onDone, onRestore }: OnboardingFlowV2Props) {
  const { state, enroll, exportBackup, reset } = useShieldedWallet()
  const [step, setStep] = useState<Step>('welcome')

  const checksum = state?.checksum ?? null

  return (
    <OnboardingLayout showMobileLogo={step === 'welcome'}>
      <div className={[flowStyles.flow, step === 'welcome' && flowStyles.flowWelcome].filter(Boolean).join(' ')}>
        {step !== 'welcome' ? (
          <FlowStepIndicator
            className={flowStyles.indicator}
            flowLabel="Set up account"
            currentStep={Math.max(1, STEP_INDEX[step])}
            totalSteps={TOTAL_STEPS}
            steps={[...STEP_LABELS]}
            status={step === 'complete' ? 'confirmed' : 'default'}
          />
        ) : null}
        <div className={flowStyles.step}>
          {step === 'welcome' && (
            <WelcomeStep onContinue={() => setStep('sign')} onRestore={onRestore} />
          )}

          {step === 'sign' && (
            <SignEnrollmentStep
              onBack={() => setStep('welcome')}
              onSign={async () => {
                await enroll()
                setStep('checksum')
              }}
            />
          )}

          {step === 'checksum' && (
            <AntiPhishChecksumStep
              checksum={checksum ?? '—'}
              onContinue={() => setStep('backup')}
              onCancelSetup={async () => {
                await reset()
                setStep('welcome')
              }}
            />
          )}

          {step === 'backup' && (
            <BackupPassphraseStep
              onCreateBackup={(passphrase) => exportBackup(passphrase)}
              onBack={() => setStep('checksum')}
              onContinue={() => setStep('confirm-backup')}
            />
          )}

          {step === 'confirm-backup' && (
            <ConfirmBackupStep
              expectedChecksum={checksum ?? ''}
              onBack={() => setStep('backup')}
              onConfirmed={() => setStep('complete')}
            />
          )}

          {step === 'complete' && <CompleteStep onDone={onDone} />}
        </div>
      </div>
    </OnboardingLayout>
  )
}
