/**
 * Privacy Pool Transaction Timeline
 *
 * Displays the stage progression for shield, transfer, and unshield transactions.
 */

import { CheckCircle2, XCircle, Clock, Loader2 } from 'lucide-react'
import type { StoredTransaction, TxStage, StageStatus } from '@/types/transaction'

// ============ Types ============

export interface PrivacyPoolTimelineProps {
  /** The transaction to display */
  transaction: StoredTransaction
  /** Whether to show compact view (fewer details) */
  compact?: boolean
  /** Custom class name */
  className?: string
}

export interface TimelineItemProps {
  stage: TxStage
  isLast: boolean
  compact?: boolean
}

// ============ Helpers ============

function getStatusIcon(status: StageStatus, isActive: boolean) {
  if (status === 'confirmed') {
    return <CheckCircle2 className="h-4 w-4 text-success" />
  }
  if (status === 'error') {
    return <XCircle className="h-4 w-4 text-error" />
  }
  if (status === 'active' || isActive) {
    return <Loader2 className="h-4 w-4 text-primary animate-spin" />
  }
  if (status === 'skipped') {
    return <div className="h-4 w-4 rounded-full border-2 border-muted" />
  }
  // pending
  return <Clock className="h-4 w-4 text-muted-foreground" />
}

function getStatusColor(status: StageStatus): string {
  switch (status) {
    case 'confirmed':
      return 'text-success'
    case 'error':
      return 'text-error'
    case 'active':
      return 'text-primary'
    case 'skipped':
      return 'text-muted-foreground/50'
    default:
      return 'text-muted-foreground'
  }
}

function formatTxHash(hash: string): string {
  if (hash.length <= 20) return hash
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`
}

function formatTimestamp(timestamp?: number): string | null {
  if (!timestamp) return null
  return new Date(timestamp).toLocaleTimeString()
}

// ============ Timeline Item Component ============

function TimelineItem({ stage, isLast, compact }: TimelineItemProps) {
  const icon = getStatusIcon(stage.status, false)
  const statusColor = getStatusColor(stage.status)

  return (
    <div className="relative pl-8">
      {/* Timeline connector line */}
      {!isLast && (
        <div
          className={`absolute left-[11px] top-[24px] bottom-[-12px] w-[2px] min-h-[24px] ${
            stage.status === 'confirmed' ? 'bg-success/30' : 'bg-border'
          }`}
        />
      )}

      {/* Stage content */}
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="relative z-10 -ml-8 flex h-6 w-6 items-center justify-center">
          {icon}
        </div>

        {/* Details */}
        <div className="flex-1 space-y-0.5 pb-4">
          {/* Label */}
          <div className={`text-sm font-medium ${statusColor}`}>
            {stage.label}
          </div>

          {/* Message */}
          {stage.message && !compact && (
            <p className="text-xs text-muted-foreground">{stage.message}</p>
          )}

          {/* Transaction hash */}
          {stage.txHash && !compact && (
            <p className="text-xs text-muted-foreground font-mono">
              Tx: {formatTxHash(stage.txHash)}
            </p>
          )}

          {/* Block number */}
          {stage.blockNumber && !compact && (
            <p className="text-xs text-muted-foreground">
              Block: {stage.blockNumber}
            </p>
          )}

          {/* Timestamp */}
          {stage.timestamp && !compact && (
            <p className="text-xs text-muted-foreground">
              {formatTimestamp(stage.timestamp)}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ============ Main Component ============

export function PrivacyPoolTimeline({
  transaction,
  compact = false,
  className = '',
}: PrivacyPoolTimelineProps) {
  const { stages } = transaction

  // Filter out stages that haven't started (for cleaner display)
  const visibleStages = stages.filter(
    (stage) =>
      stage.status !== 'pending' ||
      stage.id === transaction.currentStageId ||
      stages.findIndex((s) => s.id === stage.id) <=
        stages.findIndex((s) => s.id === transaction.currentStageId) + 1,
  )

  return (
    <div className={`space-y-0 ${className}`}>
      {visibleStages.map((stage, index) => (
        <TimelineItem
          key={stage.id}
          stage={stage}
          isLast={index === visibleStages.length - 1}
          compact={compact}
        />
      ))}
    </div>
  )
}

// ============ Compact Summary Component ============

export interface TimelineSummaryProps {
  transaction: StoredTransaction
  className?: string
}

/**
 * Compact summary showing current stage and progress
 */
export function TimelineSummary({ transaction, className = '' }: TimelineSummaryProps) {
  const { stages, status, currentStageId } = transaction

  // Count completed stages
  const completedCount = stages.filter((s) => s.status === 'confirmed').length
  const totalCount = stages.length
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0

  // Get current stage
  const currentStage = stages.find((s) => s.id === currentStageId)

  return (
    <div className={`space-y-2 ${className}`}>
      {/* Progress bar */}
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            status === 'error'
              ? 'bg-error'
              : status === 'success'
                ? 'bg-success'
                : 'bg-primary'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Current stage label */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {status === 'success'
            ? 'Completed'
            : status === 'error'
              ? 'Failed'
              : currentStage?.label || 'Processing...'}
        </span>
        <span className="text-muted-foreground">
          {completedCount}/{totalCount}
        </span>
      </div>
    </div>
  )
}
