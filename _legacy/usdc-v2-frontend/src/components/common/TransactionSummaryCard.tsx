import { ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { cn } from '@/lib/utils'

export type TransactionDirection = 'deposit' | 'send'

export interface TransactionSummaryCardProps {
  amount: string
  chainName?: string
  direction: TransactionDirection
  actionLabel?: string
  isValid: boolean
  validationError: string | null
  onContinue: () => void
  isSubmitting: boolean
  currentPhase: 'building' | 'signing' | 'submitting' | null
}

/**
 * Generic transaction summary card component.
 * Displays transaction action, amount, and continue button with loading states.
 */
export function TransactionSummaryCard({
  amount,
  chainName,
  direction,
  actionLabel,
  isValid,
  validationError,
  onContinue,
  isSubmitting,
  currentPhase,
}: TransactionSummaryCardProps) {
  // Default action label based on direction
  const defaultActionLabel = direction === 'deposit' ? 'Deposit now' : 'Send now'
  const label = actionLabel || defaultActionLabel

  // Format amount display based on direction
  const displayAmount =
    amount.trim() !== ''
      ? chainName
        ? `${amount} USDC ${direction === 'deposit' ? 'from' : 'to'} ${chainName}`
        : `${amount} USDC`
      : '0 USDC'

  return (
    <div className="card card-rounded-full card-xl mx-12">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">{label}</span>
          </div>
          {validationError && (
            <p className="text-xs text-warning ml-6">{validationError}</p>
          )}
        </div>
        <div className="flex items-center justify-between sm:justify-end gap-4">
          <span className="text-sm font-medium text-muted-foreground">{displayAmount}</span>
          <Button
            type="button"
            variant="primary"
            onClick={onContinue}
            disabled={!isValid || isSubmitting}
            className={cn(
              'rounded-full',
              (!isValid || isSubmitting) && 'opacity-50 cursor-not-allowed'
            )}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>
                  {currentPhase === 'building' && 'Building...'}
                  {currentPhase === 'signing' && 'Signing...'}
                  {currentPhase === 'submitting' && 'Submitting...'}
                  {!currentPhase && 'Processing...'}
                </span>
              </>
            ) : (
              <>
                Continue <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

