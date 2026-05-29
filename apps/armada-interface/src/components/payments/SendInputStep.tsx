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
  /**
   * CCTP fast-fee (~2 bps) on xchain kinds — deducted from the destination mint, separate
   * from `fee` (the relayer's broadcaster fee, paid by the user). Zero / ignored on local kinds.
   */
  cctpFee: bigint
  /** USDC deducted from the user's shielded balance — `amount + fee` across all three SendModal kinds. */
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
  cctpFee,
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
  // For unshield-local and unshield-xchain the user's typeable max is already shielded - fee;
  // if they exceed it, the cause is that amount + fee would overflow. Spell that out so they
  // don't think their balance number is wrong.
  const overflowMessage = isLocalUnshield || isXchain
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
        // Single "Total deducted from balance" line across all three SendModal kinds. For
        // transfer-shielded the recipient gets exactly `amount`; for unshield kinds the
        // recipient mint differs by the CCTP fast-fee already surfaced on its own row when
        // xchain. The total-deducted number is the user's load-bearing commitment in every case.
        netAmount={totalDeducted}
        netLabel="Total deducted from balance"
        // All three SendModal kinds are relayer-mediated post-A4/A5 — call the fee what it is.
        feeLabel="Relayer fee"
        secondaryFee={isXchain ? cctpFee : undefined}
        secondaryFeeLabel={isXchain ? 'CCTP delivery fee' : undefined}
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
