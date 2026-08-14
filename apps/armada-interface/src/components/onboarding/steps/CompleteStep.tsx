// ABOUTME: Step 5 of onboarding — celebratory "You're in" panel; single Done CTA returns to the Dashboard.
// ABOUTME: This step is only shown after createWallet succeeds. The actual atom write (status='unlocked') is the parent's responsibility.

import { Button, Text } from '@/design'
import styles from './CompleteStep.module.css'

export interface CompleteStepProps {
  onDone: () => void
}

export function CompleteStep({ onDone }: CompleteStepProps) {
  return (
    <div className={styles.root}>
      <Text variant="display-xl" as="h1" className={styles.title}>
        You&apos;re in
      </Text>
      <p className={styles.body}>
        Your private USDC account is ready. You can now deposit, withdraw, send, and earn —
        all privately. Sign back in any time, on any device, with the same EVM wallet. If you
        ever lose access to this wallet, an encrypted backup file (Settings → Export recovery)
        is a separate way to restore your account.
      </p>
      <div className={styles.actions}>
        <Button
          variant="gradient"
          size="md"
          label="Go to dashboard"
          showIcon
          onClick={onDone}
        />
      </div>
    </div>
  )
}
