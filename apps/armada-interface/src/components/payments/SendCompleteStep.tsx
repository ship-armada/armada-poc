// ABOUTME: Send complete step — success copy adapts to private vs external mode + chain (when external).
// ABOUTME: Mirrors the Shield/Unshield CompleteStep shape so success states across flows feel consistent.

import { CheckCircle2 } from 'lucide-react'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { formatUsdcAmount, truncateAddress } from '@/lib/format'
import { getChainById } from '@/config/network'
import type { SendTab } from './SendInputStep'
import styles from './SendCompleteStep.module.css'

export interface SendCompleteStepProps {
  tab: SendTab
  destChainId: number
  recipient: string
  /** USDC the recipient actually received on chain. See SendModal's per-kind comment. */
  recipientReceives: bigint
  onDone: () => void
}

export function SendCompleteStep({
  tab,
  destChainId,
  recipient,
  recipientReceives,
  onDone,
}: SendCompleteStepProps) {
  const destChain = tab === 'external' ? getChainById(destChainId) : null
  const short = recipient.startsWith('0zk') && recipient.length > 14
    ? `${recipient.slice(0, 7)}…${recipient.slice(-4)}`
    : truncateAddress(recipient)

  return (
    <div className={styles.root}>
      <div className={styles.icon} aria-hidden="true">
        <CheckCircle2 size={40} />
      </div>
      <h3 className={styles.title}>Sent</h3>
      <p className={styles.body}>
        {tab === 'private'
          ? <>Sent {formatUsdcAmount(recipientReceives)} USDC privately to {short}.</>
          : <>Sent {formatUsdcAmount(recipientReceives)} USDC to {short} on {destChain?.name ?? `chain ${destChainId}`}.</>}
      </p>
      <FlowFooter
        className={styles.footer}
        primary={{ label: 'Done', onClick: onDone }}
      />
    </div>
  )
}
