// ABOUTME: Onboarding step — shows the anti-phish checksum derived from root_secret so the user can recognize their own wallet on later unlocks.
// ABOUTME: Post-sign checkpoint: Continue advances to backup; Cancel opens a destructive confirm that wipes the enrolled wallet on this device.

import { useState } from 'react'
import { Text } from '@armada/ui'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { CancelSetupConfirmDialog } from '../CancelSetupConfirmDialog'
import styles from './AntiPhishChecksumStep.module.css'

export interface AntiPhishChecksumStepProps {
  checksum: string
  onContinue: () => void
  /** Wipes enrolled wallet + storage, then parent routes to welcome. */
  onCancelSetup: () => Promise<void>
}

export function AntiPhishChecksumStep({
  checksum,
  onContinue,
  onCancelSetup,
}: AntiPhishChecksumStepProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <>
      <div className={styles.root}>
        <Text variant="display-lg" as="h2" className={styles.title}>
          Your anti-phishing code
        </Text>
        <p className={styles.body}>
          This 12-character code is unique to your account. Future unlock screens display it so you
          can spot impostor sites that don't know your real keys. Write it down or commit it to memory.
        </p>
        <div className={styles.code} aria-label="Anti-phishing checksum">
          {checksum}
        </div>
        <FlowFooter
          className={styles.footer}
          layout="stack"
          primary={{ label: 'Continue', onClick: onContinue, showIcon: false }}
          secondary={{ label: 'Cancel', onClick: () => setConfirmOpen(true), showIcon: false }}
        />
      </div>
      <CancelSetupConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={onCancelSetup}
      />
    </>
  )
}
