import { useEffect } from 'react'
import { X, Loader2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import type { DepositTransactionDetails } from '@/services/deposit/depositService'

export interface DepositConfirmationModalProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  transactionDetails: DepositTransactionDetails
}

export function DepositConfirmationModal({
  open,
  onClose,
  onConfirm,
  transactionDetails,
}: DepositConfirmationModalProps) {
  // Handle Escape key to close modal
  useEffect(() => {
    if (!open) return

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open, onClose])

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }

    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) {
    return null
  }

  // Format address for display (truncate middle)
  function formatAddress(address: string): string {
    if (address.length <= 10) return address
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Content */}
      <div className="relative z-50 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Confirm Deposit</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Transaction Details */}
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <div className="space-y-3">
              {/* Amount */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Amount</span>
                <span className="text-sm font-medium">${transactionDetails.amount} USDC</span>
              </div>

              {/* Fee */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Fee</span>
                {transactionDetails.isLoadingFee ? (
                  <div className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Estimating...</span>
                  </div>
                ) : (
                  <span className="text-sm font-medium">{transactionDetails.fee}</span>
                )}
              </div>

              {/* Fee Breakdown (if available) */}
              {transactionDetails.feeBreakdown && !transactionDetails.isLoadingFee && (
                <div className="space-y-1 pl-4 text-xs text-muted-foreground">
                  {/* Only show approve fee if approval is needed */}
                  {transactionDetails.feeBreakdown.approvalNeeded !== false &&
                    parseFloat(transactionDetails.feeBreakdown.approveNative) > 0 && (
                      <div className="flex items-center justify-between">
                        <span>Approve</span>
                        <span>
                          {transactionDetails.feeBreakdown.approveNative}{' '}
                          {transactionDetails.feeBreakdown.nativeSymbol}
                          {transactionDetails.feeBreakdown.approveUsd !== undefined && (
                            <span className="ml-1 text-muted-foreground">
                              (~${transactionDetails.feeBreakdown.approveUsd.toFixed(4)})
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                  <div className="flex items-center justify-between">
                    <span>Burn</span>
                    <span>
                      {transactionDetails.feeBreakdown.burnNative}{' '}
                      {transactionDetails.feeBreakdown.nativeSymbol}
                      {transactionDetails.feeBreakdown.burnUsd !== undefined && (
                        <span className="ml-1 text-muted-foreground">
                          (~${transactionDetails.feeBreakdown.burnUsd.toFixed(4)})
                        </span>
                      )}
                    </span>
                  </div>
                  {transactionDetails.feeBreakdown.nobleRegUsd > 0 && (
                    <div className="flex items-center justify-between">
                      <span>Noble Registration</span>
                      <span>${transactionDetails.feeBreakdown.nobleRegUsd.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Total */}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-sm font-medium">Total</span>
                <span className="text-lg font-semibold">${transactionDetails.total}</span>
              </div>
            </div>
          </div>

          {/* Source Chain */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">From</span>
              <span className="text-sm font-medium">{transactionDetails.chainName}</span>
            </div>
          </div>

          {/* Destination Namada Address */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">To Namada Address</span>
            </div>
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="font-mono text-sm">{formatAddress(transactionDetails.destinationAddress)}</p>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="mt-6 flex items-center justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={onConfirm}>
            Confirm & Deposit
          </Button>
        </div>
      </div>
    </div>
  )
}

