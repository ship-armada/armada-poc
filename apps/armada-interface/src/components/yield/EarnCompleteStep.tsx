// ABOUTME: Earn complete step — success copy adapts to add (moved into vault) vs withdraw (returned to private balance).
// ABOUTME: Mirrors the other CompleteStep shapes — recipient-receives + total-deducted + explorer link.

import { CheckCircle2, ExternalLink } from 'lucide-react'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { formatUsdcAmount } from '@/lib/format'
import type { EarnTab } from './EarnInputStep'
import styles from './EarnCompleteStep.module.css'

export interface EarnCompleteStepProps {
  tab: EarnTab
  /** Add: USDC now earning yield. Withdraw: USDC returned to private balance. Equals `amount`. */
  recipientReceives: bigint
  /** Total USDC deducted from the user's shielded balance — `amount + fee` for both kinds. */
  totalDeducted: bigint
  /** Explorer URL for the hub-chain tx. Undefined for local Anvil; hidden when unset. */
  explorerUrl?: string
  onDone: () => void
}

export function EarnCompleteStep({
  tab,
  recipientReceives,
  totalDeducted,
  explorerUrl,
  onDone,
}: EarnCompleteStepProps) {
  return (
    <div className={styles.root}>
      <div className={styles.icon} aria-hidden="true">
        <CheckCircle2 size={40} />
      </div>
      <h3 className={styles.title}>
        {tab === 'add' ? 'Earning' : 'Withdrawn from vault'}
      </h3>
      <p className={styles.body}>
        {tab === 'add'
          ? <>You're now earning yield on {formatUsdcAmount(recipientReceives)} USDC.</>
          : <>Returned {formatUsdcAmount(recipientReceives)} USDC to your private balance.</>}
      </p>
      {totalDeducted !== recipientReceives ? (
        <p className={styles.body}>
          Total deducted from your private balance: {formatUsdcAmount(totalDeducted)} USDC.
        </p>
      ) : null}
      {explorerUrl ? (
        <p className={styles.body}>
          <a href={explorerUrl} target="_blank" rel="noreferrer noopener" className={styles.explorerLink}>
            View transaction <ExternalLink size={14} aria-hidden="true" />
          </a>
        </p>
      ) : null}
      <FlowFooter
        className={styles.footer}
        primary={{ label: 'Done', onClick: onDone }}
      />
    </div>
  )
}
