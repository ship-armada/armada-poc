// ABOUTME: First-run onboarding in the split-panel layout (OnboardingLayout) — 3 mandatory steps: welcome → sign → complete.
// ABOUTME: Drives useShieldedWallet().signIn() at the Sign step; backup-file export is opt-in via Settings → Export recovery (not gated on first-run). NonDeterministicSignerError routes to a dedicated screen that points users at paste/backup recovery. Anti-phish checksum step removed — see specs/TX_SIGNING_V2_AMENDMENT.md for the rationale (the user-facing display offered no defense against perfect-clone phishing, and the lib-level cached-checksum-mismatch detection covers wallet-drift automatically).

import { useState } from 'react'
import { useDisconnect } from 'wagmi'
import { FlowStepIndicator } from '@/components/flow/FlowStepIndicator'
import { OnboardingLayout } from '@/components/OnboardingLayout/OnboardingLayout'
import { WelcomeStep } from './steps/WelcomeStep'
import { SignEnrollmentStep } from './steps/SignEnrollmentStep'
import { CompleteStep } from './steps/CompleteStep'
import { NonDeterministicSignerScreen } from './NonDeterministicSignerScreen'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import type { NonDeterministicSignerErrorReason } from '@/lib/crypto/determinism'
import flowStyles from './OnboardingFlowV2.module.css'

// `signer-error` is a terminal state inside the flow but lives off the step indicator — it's
// reached from `sign` when the determinism check fails, and exits to either the unlock flow
// (paste/backup) or the entry screen (try a different wallet).
type Step = 'welcome' | 'sign' | 'complete' | 'signer-error'

const STEP_INDEX: Record<Exclude<Step, 'signer-error'>, number> = {
  welcome: 0,
  sign: 1,
  complete: 2,
}

const TOTAL_STEPS = 2
const STEP_LABELS = [
  'Set up account',
  'Set up account',
] as const

export interface OnboardingFlowV2Props {
  /** Called when the user clicks Done on the final step. Parent should swap App-level mode to "app". */
  onDone: () => void
  /**
   * Optional escape hatch — routes the user to UnlockFlow's paste/backup tabs. Parent
   * supplies this when the user is on first-run-onboarding but might already have a wallet
   * (e.g. new device or cleared storage), or when the determinism check fails and the user
   * needs to recover via backup-file / recovery-secret.
   */
  onRestore?: () => void
}

export function OnboardingFlowV2({ onDone, onRestore }: OnboardingFlowV2Props) {
  const { signIn } = useShieldedWallet()
  const { disconnect } = useDisconnect()
  const [step, setStep] = useState<Step>('welcome')
  const [signerErrorReason, setSignerErrorReason] =
    useState<NonDeterministicSignerErrorReason>('first-sign-mismatch')

  const showStepIndicator = step !== 'welcome' && step !== 'signer-error'

  return (
    <OnboardingLayout showMobileLogo={step === 'welcome'}>
      <div className={[flowStyles.flow, step === 'welcome' && flowStyles.flowWelcome].filter(Boolean).join(' ')}>
        {showStepIndicator ? (
          <FlowStepIndicator
            className={flowStyles.indicator}
            flowLabel="Set up account"
            currentStep={Math.max(1, STEP_INDEX[step as Exclude<Step, 'signer-error'>])}
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
                await signIn()
                setStep('complete')
              }}
              onSignerIncompatible={(reason) => {
                setSignerErrorReason(reason)
                setStep('signer-error')
              }}
            />
          )}

          {step === 'complete' && <CompleteStep onDone={onDone} />}

          {step === 'signer-error' && (
            <NonDeterministicSignerScreen
              reason={signerErrorReason}
              onUseRecovery={() => {
                // Route to UnlockFlow if the parent App supplied a handler; otherwise fall
                // back to disconnecting + welcoming the user. The first-run case always has
                // onRestore wired (see App.tsx), so this fallback is defensive.
                if (onRestore) {
                  onRestore()
                } else {
                  disconnect()
                  setStep('welcome')
                }
              }}
              onTryDifferentWallet={() => {
                disconnect()
                setStep('welcome')
              }}
            />
          )}
        </div>
      </div>
    </OnboardingLayout>
  )
}
