import { AmountInput, type AmountInputFeeInfo } from '@/components/common/AmountInput'

interface SendPaymentAmountInputProps {
  amount: string
  onAmountChange: (amount: string) => void
  availableBalance: string
  isShieldedBalanceLoading: boolean
  hasBalanceError: boolean
  validationError: string | null
  feeInfo: {
    feeToken: 'USDC' | 'NAM'
    feeAmount: string
  } | null
}

/**
 * Payment-specific amount input component.
 * Wraps the generic AmountInput with payment-specific configuration.
 */
export function SendPaymentAmountInput({
  amount,
  onAmountChange,
  availableBalance,
  isShieldedBalanceLoading,
  hasBalanceError,
  validationError,
  feeInfo,
}: SendPaymentAmountInputProps) {
  return (
    <AmountInput
      amount={amount}
      onAmountChange={onAmountChange}
      availableBalance={availableBalance}
      validationError={validationError}
      feeInfo={feeInfo as AmountInputFeeInfo}
      isBalanceLoading={isShieldedBalanceLoading}
      hasBalanceError={hasBalanceError}
      balanceErrorTooltip="Could not query shielded balances from chain"
    />
  )
}

