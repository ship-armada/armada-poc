import { AmountInput, type AmountInputFeeInfo } from '@/components/common/AmountInput'

interface DepositAmountInputProps {
  amount: string
  onAmountChange: (amount: string) => void
  availableBalance: string
  hasEvmError: boolean
  validationError: string | null
  feeInfo: {
    totalUsd?: number
    nobleRegUsd?: number
  } | null
}

/**
 * Deposit-specific amount input component.
 * Wraps the generic AmountInput with deposit-specific configuration.
 */
export function DepositAmountInput({
  amount,
  onAmountChange,
  availableBalance,
  hasEvmError,
  validationError,
  feeInfo,
}: DepositAmountInputProps) {
  return (
    <AmountInput
      amount={amount}
      onAmountChange={onAmountChange}
      availableBalance={availableBalance}
      validationError={validationError}
      feeInfo={feeInfo as AmountInputFeeInfo}
      hasBalanceError={hasEvmError}
      balanceErrorTooltip="Could not query EVM balance from chain"
    />
  )
}

