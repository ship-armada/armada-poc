import { TransactionSummaryCard } from '@/components/common/TransactionSummaryCard'

interface SendSummaryCardProps {
  amount: string
  chainName?: string
  isValid: boolean
  validationError: string | null
  onContinue: () => void
  isSubmitting: boolean
  currentPhase: 'building' | 'signing' | 'submitting' | null
}

/**
 * Payment-specific summary card component.
 * Wraps the generic TransactionSummaryCard with payment-specific configuration.
 */
export function SendSummaryCard({
  amount,
  chainName,
  isValid,
  validationError,
  onContinue,
  isSubmitting,
  currentPhase,
}: SendSummaryCardProps) {
  return (
    <TransactionSummaryCard
      amount={amount}
      chainName={chainName}
      direction="send"
      isValid={isValid}
      validationError={validationError}
      onContinue={onContinue}
      isSubmitting={isSubmitting}
      currentPhase={currentPhase}
    />
  )
}

