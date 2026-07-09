/**
 * Privacy Pool Transaction Card
 *
 * Displays a transaction summary card with expandable timeline.
 */

import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react'
import type { StoredTransaction, FlowType, TxStatus } from '@/types/transaction'
import { PrivacyPoolTimeline, TimelineSummary } from './PrivacyPoolTimeline'

// ============ Types ============

export interface PrivacyPoolTxCardProps {
  /** The transaction to display */
  transaction: StoredTransaction
  /** Whether the card is initially expanded */
  defaultExpanded?: boolean
  /** Callback when card is clicked */
  onClick?: (transaction: StoredTransaction) => void
  /** Custom class name */
  className?: string
}

// ============ Helpers ============

function getFlowIcon(flowType: FlowType) {
  switch (flowType) {
    case 'shield':
      return <ArrowDownToLine className="h-5 w-5" />
    case 'unshield':
      return <ArrowUpFromLine className="h-5 w-5" />
    case 'transfer':
      return <ArrowRightLeft className="h-5 w-5" />
    default:
      return null
  }
}

function getFlowLabel(flowType: FlowType): string {
  switch (flowType) {
    case 'shield':
      return 'Shield'
    case 'unshield':
      return 'Unshield'
    case 'transfer':
      return 'Transfer'
    default:
      return 'Unknown'
  }
}

function getStatusIcon(status: TxStatus) {
  switch (status) {
    case 'success':
      return <CheckCircle2 className="h-4 w-4 text-success" />
    case 'error':
      return <XCircle className="h-4 w-4 text-error" />
    case 'cancelled':
      return <XCircle className="h-4 w-4 text-muted-foreground" />
    case 'pending':
      return <Loader2 className="h-4 w-4 text-primary animate-spin" />
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />
  }
}

function getStatusLabel(status: TxStatus): string {
  switch (status) {
    case 'success':
      return 'Completed'
    case 'error':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'pending':
      return 'In Progress'
    default:
      return 'Unknown'
  }
}

function getStatusColor(status: TxStatus): string {
  switch (status) {
    case 'success':
      return 'text-success'
    case 'error':
      return 'text-error'
    case 'cancelled':
      return 'text-muted-foreground'
    case 'pending':
      return 'text-primary'
    default:
      return 'text-muted-foreground'
  }
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  if (seconds > 10) return `${seconds}s ago`
  return 'just now'
}

function formatAmount(amount: string, symbol: string): string {
  const num = parseFloat(amount)
  if (isNaN(num)) return `${amount} ${symbol}`
  return `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`
}

// ============ Main Component ============

export function PrivacyPoolTxCard({
  transaction,
  defaultExpanded = false,
  onClick,
  className = '',
}: PrivacyPoolTxCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  const handleClick = () => {
    if (onClick) {
      onClick(transaction)
    } else {
      setIsExpanded(!isExpanded)
    }
  }

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsExpanded(!isExpanded)
  }

  const { flowType, status, amount, tokenSymbol, createdAt, isCrossChain, sourceChain, destinationChain } =
    transaction

  return (
    <div
      className={`
        border rounded-lg bg-card overflow-hidden
        ${status === 'pending' ? 'border-primary/30' : 'border-border'}
        ${onClick ? 'cursor-pointer hover:border-primary/50 transition-colors' : ''}
        ${className}
      `}
      onClick={handleClick}
    >
      {/* Header */}
      <div className="p-4">
        <div className="flex items-center justify-between">
          {/* Left: Icon, Type, and Chain info */}
          <div className="flex items-center gap-3">
            <div
              className={`
                p-2 rounded-full
                ${status === 'success' ? 'bg-success/10 text-success' : ''}
                ${status === 'error' ? 'bg-error/10 text-error' : ''}
                ${status === 'pending' ? 'bg-primary/10 text-primary' : ''}
                ${status === 'cancelled' ? 'bg-muted text-muted-foreground' : ''}
              `}
            >
              {getFlowIcon(flowType)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{getFlowLabel(flowType)}</span>
                {isCrossChain && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    Cross-chain
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {sourceChain}
                {destinationChain && destinationChain !== sourceChain && ` → ${destinationChain}`}
              </p>
            </div>
          </div>

          {/* Right: Amount and Status */}
          <div className="text-right">
            <div className="font-mono font-medium">
              {formatAmount(amount, tokenSymbol)}
            </div>
            <div className={`flex items-center justify-end gap-1 text-xs ${getStatusColor(status)}`}>
              {getStatusIcon(status)}
              <span>{getStatusLabel(status)}</span>
            </div>
          </div>
        </div>

        {/* Progress summary for pending transactions */}
        {status === 'pending' && (
          <div className="mt-3">
            <TimelineSummary transaction={transaction} />
          </div>
        )}

        {/* Timestamp and expand toggle */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
          <span className="text-xs text-muted-foreground">{formatTimeAgo(createdAt)}</span>
          <button
            onClick={handleToggle}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {isExpanded ? (
              <>
                <span>Hide details</span>
                <ChevronUp className="h-4 w-4" />
              </>
            ) : (
              <>
                <span>Show details</span>
                <ChevronDown className="h-4 w-4" />
              </>
            )}
          </button>
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-border pt-4 bg-muted/20">
          <PrivacyPoolTimeline transaction={transaction} />

          {/* Error message */}
          {transaction.errorMessage && (
            <div className="mt-3 p-3 rounded bg-error/10 border border-error/20">
              <p className="text-sm text-error">{transaction.errorMessage}</p>
            </div>
          )}

          {/* Transaction hashes */}
          {(transaction.txHashes.main ||
            transaction.txHashes.approval ||
            transaction.txHashes.relay) && (
            <div className="mt-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Transaction Hashes</p>
              {transaction.txHashes.approval && (
                <p className="text-xs font-mono text-muted-foreground">
                  Approval: {transaction.txHashes.approval.slice(0, 10)}...
                  {transaction.txHashes.approval.slice(-8)}
                </p>
              )}
              {transaction.txHashes.main && (
                <p className="text-xs font-mono text-muted-foreground">
                  Main: {transaction.txHashes.main.slice(0, 10)}...
                  {transaction.txHashes.main.slice(-8)}
                </p>
              )}
              {transaction.txHashes.relay && (
                <p className="text-xs font-mono text-muted-foreground">
                  Relay: {transaction.txHashes.relay.slice(0, 10)}...
                  {transaction.txHashes.relay.slice(-8)}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============ Compact List Item ============

export interface PrivacyPoolTxListItemProps {
  transaction: StoredTransaction
  onClick?: (transaction: StoredTransaction) => void
  className?: string
}

/**
 * Compact list item for transaction history
 */
export function PrivacyPoolTxListItem({
  transaction,
  onClick,
  className = '',
}: PrivacyPoolTxListItemProps) {
  const { flowType, status, amount, tokenSymbol, createdAt } = transaction

  return (
    <div
      className={`
        flex items-center justify-between p-3 border-b border-border last:border-b-0
        ${onClick ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}
        ${className}
      `}
      onClick={() => onClick?.(transaction)}
    >
      {/* Left: Icon and Type */}
      <div className="flex items-center gap-3">
        <div className="text-muted-foreground">{getFlowIcon(flowType)}</div>
        <div>
          <span className="text-sm font-medium">{getFlowLabel(flowType)}</span>
          <p className="text-xs text-muted-foreground">{formatTimeAgo(createdAt)}</p>
        </div>
      </div>

      {/* Right: Amount and Status */}
      <div className="text-right">
        <div className="text-sm font-mono">{formatAmount(amount, tokenSymbol)}</div>
        <div className={`flex items-center justify-end gap-1 ${getStatusColor(status)}`}>
          {getStatusIcon(status)}
        </div>
      </div>
    </div>
  )
}
