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
   * Maximum amount the user can type, AFTER reserving room for the relayer fee. Modal-side:
   * `shielded - fee` for both local and xchain (both pay a broadcaster fee on top post-A5).
   * Keeps `totalDeducted ≤ shielded_balance` enforceable here at the input gate.
   */
  max: bigint
  fee: bigint | null
  /** CCTP fast-fee on xchain. Surfaced as the FeeSummary secondary row when xchain. */
  cctpFee: bigint
  /** USDC the on-chain recipient will receive. Local: `amount`. Xchain: `amount - cctpFee`. */
  recipientReceives: bigint
  /** USDC deducted from the user's shielded balance. Both kinds post-A5: `amount + fee`. */
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
  cctpFee,
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
  // Both kinds now reserve room for the relayer fee in `max` post-A5, so the overflow message
  // is the same — amount + fee exceeded the user's shielded balance.
  const overflowMessage = 'Amount + relayer fee exceeds your private balance.'
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
        // Both kinds pay a relayer broadcaster fee; xchain ALSO pays a CCTP fast-fee from the
        // destination mint. Surface the CCTP fee as the secondary row so the user can reason
        // about why their recipient-receives differs from the entered amount.
        //
        // Net layout:
        //   - local : emphasised line is `totalDeducted` (the only number that matters).
        //   - xchain: emphasised line is `recipientReceives` (what arrives on dest); the extra
        //             row surfaces `totalDeducted` so the user also sees the on-balance debit.
        netAmount={isXchain ? recipientReceives : totalDeducted}
        netLabel={isXchain ? 'Recipient receives' : 'Total deducted from balance'}
        extraNetAmount={isXchain ? totalDeducted : undefined}
        extraNetLabel={isXchain ? 'Total deducted from balance' : undefined}
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
