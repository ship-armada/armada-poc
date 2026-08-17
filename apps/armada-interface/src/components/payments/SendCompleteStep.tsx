// ABOUTME: Send complete step — success copy adapts to private vs external mode + chain (when external).
// ABOUTME: Mirrors the Shield/Unshield CompleteStep shape so success states across flows feel consistent.

import { CheckCircle2, ExternalLink } from 'lucide-react'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { formatUsdcAmount, truncateAddress } from '@/lib/format'
import { getChainById } from '@/config/network'
import type { SendFlowVariant } from './SendRecipientStep'
import styles from './SendCompleteStep.module.css'

export interface SendCompleteStepProps {
  variant: SendFlowVariant
  /** True when the recipient is a shielded 0zk address (private transfer); false for public 0x. */
  isPrivate: boolean
  destChainId: number
  recipient: string
  /** USDC the recipient actually received on chain. See SendModal's per-kind comment. */
  recipientReceives: bigint
  /** USDC actually deducted from the user's shielded balance. Render a second line when this
   *  exceeds `recipientReceives` (the unshield-local relayer-fee path); skip when they're equal. */
  totalDeducted: bigint
  /** Explorer URL for the hub-chain tx. Undefined for local Anvil; hidden when unset. */
  explorerUrl?: string
  onDone: () => void
}

export function SendCompleteStep({
  variant,
  isPrivate,
  destChainId,
  recipient,
  recipientReceives,
  totalDeducted,
  explorerUrl,
  onDone,
}: SendCompleteStepProps) {
  const destChain = isPrivate ? null : getChainById(destChainId)
  const short = recipient.startsWith('0zk') && recipient.length > 14
    ? `${recipient.slice(0, 7)}…${recipient.slice(-4)}`
    : truncateAddress(recipient)
  const title = variant === 'withdraw' ? 'Withdrawal complete' : 'Sent'

  return (
    <div className={styles.root}>
      <div className={styles.icon} aria-hidden="true">
        <CheckCircle2 size={40} />
      </div>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.body}>
        {isPrivate
          ? <>Sent {formatUsdcAmount(recipientReceives)} USDC privately to {short}.</>
          : <>Sent {formatUsdcAmount(recipientReceives)} USDC to {short} on {destChain?.name ?? `chain ${destChainId}`}.</>}
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
