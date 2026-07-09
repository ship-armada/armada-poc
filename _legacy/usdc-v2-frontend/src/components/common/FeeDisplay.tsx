import { Loader2 } from 'lucide-react'

export interface FeeDisplayProps {
  /** Fee information to display */
  feeInfo: unknown | null
  /** Whether fee is currently being estimated */
  isEstimatingFee: boolean
  /** Total amount to display */
  total: string
  /** Optional amount (used for payment when fee is in NAM) */
  amount?: string
  /** Function to format the fee display string */
  formatFee: (feeInfo: unknown) => string
  /** Function to calculate the total amount deducted */
  calculateTotal: (feeInfo: unknown, total: string, amount?: string) => string
}

/**
 * Generic fee display component for transaction flows.
 * Handles fee estimation loading state and displays formatted fee and total amounts.
 */
export function FeeDisplay({
  feeInfo,
  isEstimatingFee,
  total,
  amount,
  formatFee,
  calculateTotal,
}: FeeDisplayProps) {
  const feeDisplay = feeInfo ? formatFee(feeInfo) : '--'
  const totalDisplay = feeInfo ? calculateTotal(feeInfo, total, amount) : `$${total}`

  return (
    <div className="space-y-3 mx-auto my-8">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Network fee</span>
        {isEstimatingFee ? (
          <div className="flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Estimating...</span>
          </div>
        ) : feeInfo ? (
          <span className="text-sm font-semibold">{feeDisplay}</span>
        ) : (
          <span className="text-sm text-muted-foreground">--</span>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border pt-3 space-x-24">
        <span className="text-base font-semibold">Total amount deducted</span>
        <span className="text-xl font-bold">{totalDisplay}</span>
      </div>
    </div>
  )
}

