// ABOUTME: Unshield complete step — success panel naming the destination chain + recipient, plus a Done CTA.
// ABOUTME: Mirrors the shield CompleteStep structure but renames the body copy to reflect "withdrew" semantics.

import { CheckCircle2, ExternalLink } from 'lucide-react'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { formatUsdcAmount, truncateAddress } from '@/lib/format'
import { getChainById } from '@/config/network'
import styles from './UnshieldCompleteStep.module.css'

export interface UnshieldCompleteStepProps {
  destChainId: number
  recipient: string
  /**
   * USDC the recipient actually received on chain. Local: equals the entered amount (relayer fee
   * was added on top, deducted separately from the user's shielded balance). Xchain: equals the
   * entered amount minus the CCTP fast-transfer fee taken by the destination Iris transfer.
   */
  recipientReceives: bigint
  /**
   * USDC deducted from the user's shielded balance. Equals `recipientReceives` for xchain (the
   * fee comes out of the destination mint, not the source); larger on local (relayer fee added).
   * When the two are equal we skip rendering the "Total deducted" line to keep the success
   * panel uncluttered.
   */
  totalDeducted: bigint
  /** Explorer URL for the source-chain tx hash. Undefined for local Anvil; hidden when unset. */
  explorerUrl?: string
  onDone: () => void
}

export function UnshieldCompleteStep({
  destChainId,
  recipient,
  recipientReceives,
  totalDeducted,
  explorerUrl,
  onDone,
}: UnshieldCompleteStepProps) {
  const destChain = getChainById(destChainId)
  const showDeductionLine = totalDeducted !== recipientReceives
  return (
    <div className={styles.root}>
      <div className={styles.icon} aria-hidden="true">
        <CheckCircle2 size={40} />
      </div>
      <h3 className={styles.title}>Withdrawal complete</h3>
      <p className={styles.body}>
        Sent {formatUsdcAmount(recipientReceives)} USDC to {truncateAddress(recipient)} on{' '}
        {destChain?.name ?? `chain ${destChainId}`}.
      </p>
      {showDeductionLine ? (
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
