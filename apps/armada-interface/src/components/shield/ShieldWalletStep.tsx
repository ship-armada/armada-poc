// ABOUTME: Shield wallet-approve step — the mockup's dedicated "step 3" wallet page. Shows the live approve/sign checklist.
// ABOUTME: Title transitions "Preparing your deposit…" (proof building, no prompt yet) → "Confirm in your wallet" (a prompt is live).

import { modalStepBodyEnter } from '@/design'
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
  const title = prompting ? 'Confirm in your wallet' : 'Preparing your deposit…'
  const subtitle = prompting
    ? 'Approve the request(s) in your wallet to continue.'
    : 'Building your zero-knowledge proof…'

  return (
    <div className={styles.root}>
      <div className={`${styles.body} ${modalStepBodyEnter}`}>
        <div className={styles.header}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
        <WalletConfirmList steps={steps} />
      </div>
    </div>
  )
}
