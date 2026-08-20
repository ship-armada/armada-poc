// ABOUTME: Shield wallet-approve step — the mockup's dedicated "step 3" wallet page (centered title + approve/sign checklist + footer).
// ABOUTME: Footer transitions "Preparing your deposit…" (proof building, no prompt yet) → "Waiting for wallet confirmation" (a prompt is live).

import { modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { WalletConfirmList } from '@/components/flow/WalletConfirmList/WalletConfirmList'
import type { WalletStep } from '@/lib/tx/shieldWalletSteps'
import styles from './ShieldWalletStep.module.css'

export interface ShieldWalletStepProps {
  steps: WalletStep[]
}

export function ShieldWalletStep({ steps }: ShieldWalletStepProps) {
  // A row is `loading` only while its wallet prompt is actually live. Before that (proof building)
  // every row is `pending` — surface the honest "preparing" copy so the user isn't told to confirm
  // a prompt that hasn't popped yet.
  const prompting = steps.some((s) => s.status === 'loading')
  const footer = prompting ? 'Waiting for wallet confirmation' : 'Preparing your deposit…'

  return (
    <div className={styles.column}>
      <div className={`${styles.body} ${modalStepBodyEnter}`}>
        <h1 className={styles.title}>Confirm transactions on your wallet</h1>
        <WalletConfirmList className={styles.confirmList} steps={steps} />
      </div>
      <div className={modalActionRowEnter}>
        <p className={styles.footerText} aria-live="polite" aria-atomic="true">
          {footer}
        </p>
      </div>
    </div>
  )
}
