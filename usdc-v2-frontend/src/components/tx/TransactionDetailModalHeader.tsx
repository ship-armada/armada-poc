import { X, CheckCircle2, XCircle, Clock, AlertCircle } from 'lucide-react'
import type { StoredTransaction, FlowType } from '@/types/transaction'
import { cn } from '@/lib/utils'

// ============ Helper functions ============

/**
 * Check if transaction succeeded
 */
function isSuccess(tx: StoredTransaction): boolean {
  return tx.status === 'success'
}

/**
 * Check if transaction failed
 */
function isError(tx: StoredTransaction): boolean {
  return tx.status === 'error'
}

/**
 * Get human-readable flow type label
 */
function getFlowTypeLabel(flowType: FlowType): string {
  switch (flowType) {
    case 'shield':
      return 'Shield'
    case 'transfer':
      return 'Transfer'
    case 'unshield':
      return 'Unshield'
    default:
      return flowType
  }
}

export interface TransactionDetailModalHeaderProps {
  transaction: StoredTransaction
  statusLabel: string
  startedAt: string
  onClose: () => void
}

export function TransactionDetailModalHeader({
  transaction,
  statusLabel,
  startedAt,
  onClose,
}: TransactionDetailModalHeaderProps) {
  // Status icon based on new model
  let statusIcon = <Clock className="h-5 w-5" />
  if (isSuccess(transaction)) {
    statusIcon = <CheckCircle2 className="h-5 w-5" />
  } else if (isError(transaction)) {
    statusIcon = <XCircle className="h-5 w-5" />
  } else if (transaction.status === 'cancelled') {
    statusIcon = <AlertCircle className="h-5 w-5" />
  }

  // Get chain display for cross-chain transactions
  const sourceChain = transaction.sourceChain.charAt(0).toUpperCase() + transaction.sourceChain.slice(1)
  const destChain = transaction.destinationChain
    ? transaction.destinationChain.charAt(0).toUpperCase() + transaction.destinationChain.slice(1)
    : 'Shielded'

  return (
    <div className="sticky top-0 z-20 flex items-center justify-between bg-background p-6">
      <div className="flex items-baseline justify-between flex-1 pr-4 gap-1">
        <div className="flex items-center gap-2">
          {/* Flow type label with chain info */}
          <h2 className="text-xl font-semibold">
            {getFlowTypeLabel(transaction.flowType)}
          </h2>
          {transaction.isCrossChain && (
            <>
              <span className="text-muted-foreground text-sm">
                ({sourceChain} → {destChain})
              </span>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground self-center">
          Started {startedAt}
        </p>
      </div>
      <div className="flex items-center gap-3">
        {/* Status Badge */}
        <div className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
          isSuccess(transaction) ? 'bg-success/10 text-success' :
            isError(transaction) ? 'bg-error/10 text-error' :
              transaction.status === 'cancelled' ? 'bg-warning/10 text-warning' :
                'bg-muted text-muted-foreground'
        )}>
          {statusIcon}
          <span className="text-xs font-medium">{statusLabel}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label="Close modal"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}

