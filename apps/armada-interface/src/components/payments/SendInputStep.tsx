// ABOUTME: Send input step — tab switcher (Private / External) + per-tab fields. Validates the recipient format per tab.
// ABOUTME: Private tab: 0zk recipient. External tab: chain selector + 0x recipient. Both use the big-display AmountInput + FeeSummary.

import { AmountInput, ChainSelect, FeeSummary, RecipientInput, Tabs } from '@/components/ui'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { isEvmAddress, isShieldedAddress } from '@/lib/address'
import styles from './SendInputStep.module.css'

export type SendTab = 'private' | 'external'

const TABS = [
  { id: 'private' as const, label: 'Private (0zk)' },
  { id: 'external' as const, label: 'External wallet' },
] as const

export interface SendInputStepProps {
  tab: SendTab
  onTabChange: (next: SendTab) => void
  destChainId: number
  onDestChainIdChange: (chainId: number) => void
  recipient: string
  onRecipientChange: (next: string) => void
  amountStr: string
  onAmountChange: (next: string) => void
  /**
   * Maximum typeable amount with the fee already reserved for relayer-mediated kinds.
   * Modal-side: `shielded - fee` for unshield-local, `shielded` for transfer-shielded + xchain.
   * Keeps `totalDeducted ≤ shielded` enforceable here without leaking per-kind math.
   */
  max: bigint
  fee: bigint | null
  /** USDC the recipient actually receives. Local + transfer: `amount`. Xchain: `amount - fee`. */
  recipientReceives: bigint
  /** USDC deducted from the user's shielded balance. Local: `amount + fee`. Others: `amount`. */
  totalDeducted: bigint
  isXchain: boolean
  isLocalUnshield: boolean
  isFeeRefreshing?: boolean
  /** When set, the destination chain has no deployment manifest — block Continue and explain inline. */
  destDeploymentError?: string
  onCancel: () => void
  onContinue: () => void
}

export function SendInputStep({
  tab,
  onTabChange,
  destChainId,
  onDestChainIdChange,
  recipient,
  onRecipientChange,
  amountStr,
  onAmountChange,
  max,
  fee,
  recipientReceives,
  totalDeducted,
  isXchain,
  isLocalUnshield,
  isFeeRefreshing,
  destDeploymentError,
  onCancel,
  onContinue,
}: SendInputStepProps) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > max
  // For unshield-local the user's typeable max is already shielded - fee; if they exceed it,
  // the cause is that amount + fee would overflow. Spell that out so they don't think their
  // balance number is wrong.
  const overflowMessage = isLocalUnshield
    ? 'Amount + relayer fee exceeds your private balance.'
    : 'Amount exceeds your private balance.'
  const amountError = usdcInputErrorMessage(parseError)
    ?? (tooMuch ? overflowMessage : undefined)

  const recipientTrimmed = recipient.trim()
  const recipientValid =
    tab === 'private' ? isShieldedAddress(recipientTrimmed) : isEvmAddress(recipientTrimmed)
  const recipientInvalid = recipientTrimmed.length > 0 && !recipientValid
  const recipientError = recipientInvalid
    ? tab === 'private'
      ? 'Enter a valid shielded address (0zk…).'
      : 'Enter a valid EVM address (0x… 42 chars).'
    : undefined

  const isValid = amount > 0n && !tooMuch && !parseError && recipientValid && !destDeploymentError

  return (
    <div className={styles.root}>
      <Tabs items={TABS} selected={tab} onSelect={onTabChange} ariaLabel="Send mode" />
      {tab === 'external' ? (
        <ChainSelect
          label="To chain"
          value={destChainId}
          onChange={onDestChainIdChange}
        />
      ) : null}
      {isXchain ? (
        <div className={styles.xchainNotice}>
          Cross-chain payment takes a few minutes for the CCTP confirmation.
        </div>
      ) : null}
      {destDeploymentError ? (
        <div className={styles.destError} role="alert">
          {destDeploymentError}
        </div>
      ) : null}
      <RecipientInput
        label="Recipient address"
        value={recipient}
        onValueChange={onRecipientChange}
        error={recipientError}
        placeholder={tab === 'private' ? '0zk…' : '0x…'}
      />
      <AmountInput
        variant="display"
        label="How much USDC?"
        value={amountStr}
        onValueChange={onAmountChange}
        max={max}
        error={amountError}
      />
      <FeeSummary
        fee={fee}
        // Per-kind bottom line — see SendModal's per-kind comment.
        netAmount={isLocalUnshield ? totalDeducted : recipientReceives}
        netLabel={isLocalUnshield ? 'Total deducted from balance' : "They'll receive"}
        feeLabel={isXchain ? 'CCTP fee' : isLocalUnshield ? 'Relayer fee' : 'Estimated fee'}
        isRefreshing={isFeeRefreshing}
      />
      <FlowFooter
        className={styles.footer}
        primary={{ label: 'Continue', onClick: onContinue, disabled: !isValid }}
        secondary={{ label: 'Cancel', onClick: onCancel }}
      />
    </div>
  )
}
