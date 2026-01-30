/**
 * Chain Status Timeline Component
 * 
 * Displays per-chain tracking status with visual timeline indicators.
 * Shows success, error, timeout, pending, and cancelled states for each chain.
 */

import { memo } from 'react'
import { CheckCircle2, XCircle, Clock, Ban } from 'lucide-react'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import type { ChainKey } from '@/shared/flowStages'
import { getChainOrder } from '@/shared/flowStages'
import {
  getAllChainStatuses,
  formatChainStatus,
  formatChainErrorMessage,
  getChainStatusColor,
} from '@/services/polling/pollingStatusUtils'
import { sanitizeError } from '@/utils/errorSanitizer'
import { cn } from '@/lib/utils'

export interface ChainStatusTimelineProps {
  transaction: StoredTransaction
  className?: string
}

function ChainStatusIcon({ status }: { status: 'success' | 'error' | 'timeout' | 'pending' | 'cancelled' | 'not_started' }) {
  switch (status) {
    case 'success':
      return <CheckCircle2 className="h-4 w-4 text-success" />
    case 'error':
      return <XCircle className="h-4 w-4 text-error" />
    case 'timeout':
      return <Clock className="h-4 w-4 text-warning" />
    case 'pending':
      return <Clock className="h-4 w-4 text-info animate-spin" />
    case 'cancelled':
      return <Ban className="h-4 w-4 text-muted-foreground" />
    case 'not_started':
      return <Clock className="h-4 w-4 text-muted-foreground" />
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />
  }
}

function getStatusType(chainStatus: ReturnType<typeof getAllChainStatuses>[ChainKey]): 'success' | 'error' | 'timeout' | 'pending' | 'cancelled' | 'not_started' {
  if (!chainStatus) {
    return 'not_started'
  }

  switch (chainStatus.status) {
    case 'success':
      return 'success'
    case 'tx_error':
    case 'polling_error':
      return 'error'
    case 'polling_timeout':
      return 'timeout'
    case 'cancelled':
      return 'cancelled'
    case 'pending':
      return 'pending'
    default:
      return 'not_started'
  }
}

export const ChainStatusTimeline = memo(function ChainStatusTimeline({
  transaction,
  className,
}: ChainStatusTimelineProps) {
  const flowType = transaction.direction === 'deposit' ? 'deposit' : 'payment'
  const chainOrder = getChainOrder(flowType)
  const chainStatuses = getAllChainStatuses(transaction)

  // Chain display names
  const chainNames: Record<ChainKey, string> = {
    evm: transaction.direction === 'deposit' 
      ? (transaction.depositDetails?.chainName || transaction.chain || 'EVM')
      : (transaction.paymentDetails?.chainName || transaction.chain || 'EVM'),
    noble: 'Noble',
    namada: 'Namada',
  }

  return (
    <div className={cn('space-y-3', className)}>
      <h3 className="text-sm font-semibold">Chain Status</h3>
      
      <div className="space-y-2">
        {chainOrder.map((chain, index) => {
          const chainStatus = chainStatuses[chain]
          const statusType = getStatusType(chainStatus)
          const statusText = formatChainStatus(chainStatus)
          const errorMessage = formatChainErrorMessage(chainStatus)
          const isLast = index === chainOrder.length - 1

          return (
            <div key={chain} className="flex items-start gap-3">
              {/* Timeline connector */}
              {!isLast && (
                <div className="flex flex-col items-center pt-1">
                  <ChainStatusIcon status={statusType} />
                  <div className={cn(
                    'w-0.5 flex-1 mt-1',
                    statusType === 'success' ? 'bg-success' :
                    statusType === 'error' ? 'bg-error' :
                    statusType === 'timeout' ? 'bg-warning' :
                    statusType === 'pending' ? 'bg-info' :
                    statusType === 'cancelled' ? 'bg-muted' :
                    'bg-muted'
                  )} />
                </div>
              )}
              
              {isLast && (
                <div className="pt-1">
                  <ChainStatusIcon status={statusType} />
                </div>
              )}

              {/* Chain info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{chainNames[chain]}</span>
                  <span className={cn('text-xs', getChainStatusColor(chainStatus))}>
                    {statusText}
                  </span>
                </div>
                
                {errorMessage && (
                  <div className="mt-1 text-xs text-error break-words">
                    {sanitizeError(errorMessage).message}
                  </div>
                )}

                {chainStatus?.completedStages && chainStatus.completedStages.length > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Completed: {chainStatus.completedStages.join(', ')}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Overall tracking status */}
      {transaction.pollingState && (
        <div className="mt-4 pt-4 border-t border-border">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Tracking Status:</span>
            <span className={cn(
              'font-medium',
              transaction.pollingState.flowStatus === 'success' ? 'text-success' :
              transaction.pollingState.flowStatus === 'tx_error' || transaction.pollingState.flowStatus === 'polling_error' ? 'text-error' :
              transaction.pollingState.flowStatus === 'polling_timeout' ? 'text-warning' :
              transaction.pollingState.flowStatus === 'user_action_required' ? 'text-warning' :
              transaction.pollingState.flowStatus === 'cancelled' ? 'text-muted-foreground' :
              'text-info'
            )}>
              {transaction.pollingState.flowStatus === 'success' ? 'Success' :
               transaction.pollingState.flowStatus === 'tx_error' ? 'Transaction Error' :
               transaction.pollingState.flowStatus === 'polling_error' ? 'Tracking Error' :
               transaction.pollingState.flowStatus === 'polling_timeout' ? 'Timeout' :
               transaction.pollingState.flowStatus === 'user_action_required' ? 'User Action Required' :
               transaction.pollingState.flowStatus === 'cancelled' ? 'Cancelled' :
               'In Progress'}
            </span>
          </div>
          
          {transaction.pollingState.lastUpdatedAt && (
            <div className="mt-1 text-xs text-muted-foreground">
              Last updated: {new Date(transaction.pollingState.lastUpdatedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

