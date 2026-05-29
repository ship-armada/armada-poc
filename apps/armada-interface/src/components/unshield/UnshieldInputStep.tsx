// ABOUTME: Unshield input step — destination chain + recipient + amount + fee summary, with cross-chain notice when the destination is a client chain.
// ABOUTME: Validates amount > 0 ≤ max AND recipient is a valid EVM address; disables Continue until both hold.

import { AmountInput, ChainSelect, FeeSummary, RecipientInput } from '@/components/ui'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { isEvmAddress } from '@/lib/address'
import styles from './UnshieldInputStep.module.css'

export interface UnshieldInputStepProps {
  destChainId: number
  onDestChainIdChange: (chainId: number) => void
  recipient: string
  onRecipientChange: (next: string) => void
  amountStr: string
  onAmountChange: (next: string) => void
  /**
   * Maximum amount the user can type, AFTER reserving room for the fee on the local
   * (relayer-mediated) path. Modal-side: `shielded - fee` for local, `shielded` for xchain.
   * Keeps `totalDeducted ≤ shielded_balance` enforceable here at the input gate.
   */
  max: bigint
  fee: bigint | null
  /** USDC the on-chain recipient will receive. Equals `amount` for local; `amount - fee` for xchain. */
  recipientReceives: bigint
  /** USDC actually deducted from the user's shielded balance. Equals `amount + fee` for local; `amount` for xchain. */
  totalDeducted: bigint
  isXchain: boolean
  isFeeRefreshing?: boolean
  onCancel: () => void
  onContinue: () => void
}

export function UnshieldInputStep({
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
  isFeeRefreshing,
  onCancel,
  onContinue,
}: UnshieldInputStepProps) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > max
  // Parser-side errors (too-many-decimals etc) take precedence over balance-bound errors.
  // Message differs by kind so the user understands why their balance is "off" — for local the
  // fee reduces what they can type by the fee amount; for xchain the full balance is typeable.
  const overflowMessage = isXchain
    ? 'Amount exceeds your private balance.'
    : 'Amount + relayer fee exceeds your private balance.'
  const amountError = usdcInputErrorMessage(parseError)
    ?? (tooMuch ? overflowMessage : undefined)

  const recipientTrimmed = recipient.trim()
  // Empty recipient is allowed (no error shown); validation only kicks in once the user types something.
  const recipientInvalid = recipientTrimmed.length > 0 && !isEvmAddress(recipientTrimmed)
  const recipientError = recipientInvalid ? 'Enter a valid EVM address (0x… 42 chars).' : undefined

  const isValid =
    amount > 0n &&
    !tooMuch &&
    !parseError &&
    isEvmAddress(recipientTrimmed)

  return (
    <div className={styles.root}>
      <ChainSelect
        label="To chain"
        value={destChainId}
        onChange={onDestChainIdChange}
      />
      {isXchain ? (
        <div className={styles.xchainNotice}>
          Cross-chain withdrawal takes a few minutes for the CCTP confirmation.
        </div>
      ) : null}
      <RecipientInput
        label="Recipient address"
        value={recipient}
        onValueChange={onRecipientChange}
        error={recipientError}
        placeholder="0x…"
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
        // Bottom line of the summary captures the kind-specific "the part the user needs to
        // know": for xchain, the recipient receives the amount minus CCTP fee — so we show that.
        // For local (relayer-mediated), the recipient receives the full entered amount and the
        // fee is added on top — so we show the total deducted instead.
        netAmount={isXchain ? recipientReceives : totalDeducted}
        netLabel={isXchain ? "Recipient receives" : 'Total deducted from balance'}
        feeLabel={isXchain ? 'CCTP fee' : 'Relayer fee'}
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
