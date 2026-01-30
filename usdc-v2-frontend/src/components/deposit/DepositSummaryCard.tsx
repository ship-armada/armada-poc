import { TransactionSummaryCard } from '@/components/common/TransactionSummaryCard'

interface DepositSummaryCardProps {
  amount: string
  chainName?: string
  isValid: boolean
  validationError: string | null
  onContinue: () => void
  isSubmitting: boolean
  currentPhase: 'building' | 'signing' | 'submitting' | null
}

/**
 * Deposit-specific summary card component.
 * Wraps the generic TransactionSummaryCard with deposit-specific configuration.
 */
export function DepositSummaryCard({
  amount,
  chainName,
  isValid,
  validationError,
  onContinue,
  isSubmitting,
  currentPhase,
}: DepositSummaryCardProps) {
  return (
    <TransactionSummaryCard
      amount={amount}
      chainName={chainName}
      direction="deposit"
      isValid={isValid}
      validationError={validationError}
      onContinue={onContinue}
      isSubmitting={isSubmitting}
      currentPhase={currentPhase}
    />
  )
}

