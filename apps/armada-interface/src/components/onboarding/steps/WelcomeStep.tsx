// ABOUTME: Step 1 of onboarding — welcomes the user and explains the private account before any keys are generated.
// ABOUTME: Primary CTA "Create account"; optional ghost "Restore an account" when onRestore is supplied (returning user / new device path — routes to UnlockFlow whose Sign-in tab covers re-sign + the Backup/Paste tabs cover the recovery-material paths).

import { Button, Text } from '@/design'
import styles from './WelcomeStep.module.css'

export interface WelcomeStepProps {
  onContinue: () => void
  /**
   * Switch to the UnlockFlow (Sign in / Backup file / Paste secret). Only passed by App.tsx
   * when the user has no existing wallet on this device — handles the "new device" / "cleared
   * storage" case where the user is actually a returning user the app would otherwise route
   * through Create. Covers all three v2 recovery paths: re-sign with the same EVM wallet is
   * the default, backup-file + paste-secret cover the cases where the EVM wallet isn't
   * available on this device.
   */
  onRestore?: () => void
}

export function WelcomeStep({ onContinue, onRestore }: WelcomeStepProps) {
  return (
    <div className={styles.root}>
      <Text variant="ui-label-xs" as="p" className={styles.eyebrow}>
        Welcome to Armada
      </Text>
      <Text variant="display-xl" as="h1" className={styles.title}>
        Create your private USDC account
      </Text>
      <p className={styles.body}>
        Armada keeps your USDC balance and activity private. Your shielded wallet keys are derived from a
        signature your EVM wallet produces — no passphrase, no recovery phrase to write down. You
        can sign back in any time from any device with the same wallet. An encrypted backup file
        is available later in Settings.
      </p>
      <div className={styles.actions}>
        <Button
          variant="gradient"
          size="md"
          label="Create account"
          showIcon
          onClick={onContinue}
        />
        {onRestore ? (
          <Button
            variant="ghost"
            size="md"
            label="Restore an account"
            showIcon={false}
            onClick={onRestore}
          />
        ) : null}
      </div>
    </div>
  )
}
