import { Loader2, AlertCircle } from 'lucide-react'
import { Tooltip } from '@/components/common/Tooltip'
import { handleAmountInputChange } from '@/services/validation'

export interface AmountInputFeeInfo {
  // For deposit fees
  totalUsd?: number
  nobleRegUsd?: number
  // For payment fees
  feeToken?: 'USDC' | 'NAM'
  feeAmount?: string
}

export interface AmountInputProps {
  amount: string
  onAmountChange: (amount: string) => void
  availableBalance: string
  validationError: string | null
  feeInfo: AmountInputFeeInfo | null
  // Balance state indicators
  isBalanceLoading?: boolean
  hasBalanceError?: boolean
  balanceErrorTooltip?: string
  // Custom "Use Max" calculation
  onUseMax?: (balance: number, fees: number) => number
  disabled?: boolean
}

/**
 * Generic amount input component for deposit and payment flows.
 * Handles balance display, fee calculation, and validation errors.
 */
export function AmountInput({
  amount,
  onAmountChange,
  availableBalance,
  validationError,
  feeInfo,
  isBalanceLoading = false,
  hasBalanceError = false,
  balanceErrorTooltip,
  onUseMax,
  disabled = false,
}: AmountInputProps) {
  const handleUseMax = () => {
    if (availableBalance === '--' || availableBalance === '0.00') {
      return
    }

    const balanceNum = parseFloat(availableBalance)
    if (isNaN(balanceNum)) {
      return
    }

    let fees = 0

    // Calculate fees based on feeInfo structure
    if (feeInfo) {
      if (feeInfo.totalUsd !== undefined || feeInfo.nobleRegUsd !== undefined) {
        // Deposit fee structure
        const feeUsd = feeInfo.totalUsd ?? 0
        const nobleRegUsd = feeInfo.nobleRegUsd ?? 0
        fees = feeUsd + nobleRegUsd
      } else if (feeInfo.feeToken === 'USDC' && feeInfo.feeAmount) {
        // Payment fee structure (only subtract if fee is in USDC)
        fees = parseFloat(feeInfo.feeAmount) || 0
      }
    }

    // Use custom calculation if provided, otherwise use default
    const maxAmount = onUseMax
      ? onUseMax(balanceNum, fees)
      : Math.max(0, balanceNum - fees)

    // Format to 6 decimal places to match input handling
    onAmountChange(maxAmount.toFixed(6).replace(/\.?0+$/, ''))
  }

  const isUseMaxDisabled = availableBalance === '--' || availableBalance === '0.00'

  return (
    <div className="card card-xl">
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              Available {availableBalance} USDC
            </span>
            {isBalanceLoading && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                aria-label="Loading balance"
              />
            )}
            {hasBalanceError && (
              <Tooltip
                content={balanceErrorTooltip || 'Could not query balance from chain'}
                side="top"
              >
                <AlertCircle
                  className="h-3.5 w-3.5 text-error"
                  aria-label="Balance error"
                />
              </Tooltip>
            )}
          </div>
          <button
            type="button"
            onClick={handleUseMax}
            disabled={isUseMaxDisabled || disabled}
            className="text-sm font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Use Max
          </button>
        </div>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold text-muted-foreground">$</span>
        <input
          type="text"
          value={amount}
          onChange={(e) => handleAmountInputChange(e, onAmountChange, 6)}
          className="flex-1 border-none bg-transparent p-0 text-3xl font-bold focus:outline-none focus:ring-0 placeholder:text-muted-foreground/30"
          placeholder="0.00"
          inputMode="decimal"
          disabled={disabled}
        />
        <div className="flex items-center gap-1.5">
          <img
            src="/assets/logos/usdc-logo.svg"
            alt="USDC"
            className="h-4 w-4"
          />
          <span className="text-sm text-muted-foreground">USDC</span>
        </div>
      </div>
      {/* Validation error for amount */}
      {validationError && amount.trim() !== '' && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="flex-1">{validationError}</span>
        </div>
      )}
    </div>
  )
}

