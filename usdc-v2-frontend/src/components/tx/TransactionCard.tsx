import { useState, memo } from 'react'
import { useAtomValue } from 'jotai'
import { Trash2, MoreVertical } from 'lucide-react'
import type { StoredTransaction, FlowType } from '@/types/transaction'
import { TransactionDetailModal } from './TransactionDetailModal'
import { DeleteTransactionConfirmationDialog } from './DeleteTransactionConfirmationDialog'
import { DropdownMenu, DropdownMenuItem } from '@/components/common/DropdownMenu'
import { cn } from '@/lib/utils'
import { getAddressDisplay } from '@/utils/addressDisplayUtils'
import { TransactionTypeIcon } from './TransactionTypeIcon'
import { TransactionStatusBadge } from './TransactionStatusBadge'
import { TransactionProgressBar } from './TransactionProgressBar'
import { TransactionAddressRow } from './TransactionAddressRow'
import { TransactionAmountDisplay } from './TransactionAmountDisplay'
import { TransactionTimeDisplay } from './TransactionTimeDisplay'
import { addressBookAtom } from '@/atoms/addressBookAtom'

// ============ Helper functions for new StoredTransaction model ============

/**
 * Map flowType to display direction for UI components
 */
function getDisplayDirection(flowType: FlowType): 'deposit' | 'send' {
  // Shield is like a deposit (public → private)
  // Transfer and unshield are like sends (private → somewhere)
  return flowType === 'shield' ? 'deposit' : 'send'
}

/**
 * Get human-readable label for flow type
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

/**
 * Check if transaction is in progress
 */
function isInProgress(tx: StoredTransaction): boolean {
  return tx.status === 'pending'
}

/**
 * Get status label from transaction
 */
function getStatusLabel(tx: StoredTransaction): string {
  switch (tx.status) {
    case 'pending':
      return 'In Progress'
    case 'success':
      return 'Completed'
    case 'error':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    default:
      return tx.status
  }
}

/**
 * Format time elapsed since transaction creation
 */
function getTimeElapsed(tx: StoredTransaction): string {
  const now = Date.now()
  const elapsedMs = now - tx.createdAt

  if (elapsedMs < 1000) {
    return 'Just now'
  }

  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) {
    return `${seconds}s ago`
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Format duration for in-progress transactions
 */
function getDurationLabel(tx: StoredTransaction): string {
  const now = Date.now()
  const durationMs = now - tx.createdAt

  if (durationMs < 1000) {
    return '< 1s'
  }

  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

/**
 * Calculate progress percentage based on confirmed stages
 */
function getProgressPercentage(tx: StoredTransaction): number {
  if (tx.status === 'success') return 100
  if (tx.status === 'error' || tx.status === 'cancelled') return 0

  const totalStages = tx.stages.length
  if (totalStages === 0) return 0

  const confirmedStages = tx.stages.filter((s) => s.status === 'confirmed').length
  return Math.round((confirmedStages / totalStages) * 100)
}

/**
 * Get status badge classes based on transaction status
 */
function getStatusBadgeClasses(tx: StoredTransaction): { bg: string; text: string; border: string } {
  switch (tx.status) {
    case 'success':
      return {
        bg: 'bg-success/20',
        text: 'text-success',
        border: 'border-success/30',
      }
    case 'error':
      return {
        bg: 'bg-error/20',
        text: 'text-error',
        border: 'border-error/30',
      }
    case 'cancelled':
      return {
        bg: 'bg-warning/20',
        text: 'text-warning',
        border: 'border-warning/30',
      }
    default:
      return {
        bg: 'bg-muted',
        text: 'text-muted-foreground',
        border: 'border-muted',
      }
  }
}

/**
 * Get icon classes based on transaction status and flow type
 */
function getTransactionIconClasses(tx: StoredTransaction): { bg: string; text: string } {
  if (tx.status === 'error') {
    return { bg: 'bg-error/10', text: 'text-error' }
  }
  if (tx.status === 'cancelled') {
    return { bg: 'bg-warning/10', text: 'text-warning' }
  }

  // Color by flow type
  switch (tx.flowType) {
    case 'shield':
      return { bg: 'bg-primary/10', text: 'text-primary' }
    case 'transfer':
      return { bg: 'bg-info/10', text: 'text-info' }
    case 'unshield':
      return { bg: 'bg-accent/10', text: 'text-accent' }
    default:
      return { bg: 'bg-muted', text: 'text-muted-foreground' }
  }
}

/**
 * Get the display address for a transaction
 */
function getDisplayAddress(tx: StoredTransaction): string | undefined {
  switch (tx.flowType) {
    case 'shield':
      // Shield: show the public address that's shielding
      return tx.publicAddress
    case 'transfer':
      // Transfer: show the recipient railgun address
      return tx.recipientAddress
    case 'unshield':
      // Unshield: show the recipient public address
      return tx.recipientAddress
    default:
      return undefined
  }
}

/**
 * Get chain display name
 */
function getChainDisplayName(tx: StoredTransaction): string {
  // For now, just capitalize the chain key
  const chain = tx.isCrossChain ? tx.sourceChain : 'hub'
  return chain.charAt(0).toUpperCase() + chain.slice(1)
}

export interface TransactionCardProps {
  transaction: StoredTransaction
  variant?: 'compact' | 'detailed'
  onClick?: () => void
  showExpandButton?: boolean
  onDelete?: (txId: string) => void
  hideActions?: boolean // Hide the actions column (dropdown menu)
  // Optional external modal state control (for persistence across component remounts)
  isModalOpen?: boolean
  onModalOpenChange?: (open: boolean) => void
}

export const TransactionCard = memo(function TransactionCard({
  transaction,
  variant = 'compact',
  onClick,
  showExpandButton = true,
  onDelete,
  hideActions = false,
  isModalOpen: externalIsModalOpen,
  onModalOpenChange,
}: TransactionCardProps) {
  // Use external modal state if provided, otherwise use internal state
  const [internalIsModalOpen, setInternalIsModalOpen] = useState(false)
  const isModalOpen = externalIsModalOpen !== undefined ? externalIsModalOpen : internalIsModalOpen
  const setIsModalOpen = onModalOpenChange || setInternalIsModalOpen

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const addressBookEntries = useAtomValue(addressBookAtom)

  // Get the address to display using new model
  const displayAddress = getDisplayAddress(transaction)
  const addressDisplayInfo = getAddressDisplay(displayAddress, addressBookEntries)

  const handleClick = () => {
    if (onClick) {
      onClick()
    } else if (showExpandButton) {
      setIsModalOpen(true)
    }
  }

  const handleDeleteConfirm = () => {
    if (onDelete) {
      onDelete(transaction.id)
    }
  }

  // Map flowType to direction for UI components that expect it
  const direction = getDisplayDirection(transaction.flowType)
  const statusLabel = getStatusLabel(transaction)

  // Only calculate progress if transaction is in progress (when progress bar will be shown)
  const progress = isInProgress(transaction)
    ? getProgressPercentage(transaction)
    : 0

  // Show duration for in-progress transactions, "time ago" for others
  const timeDisplay = isInProgress(transaction)
    ? getDurationLabel(transaction)
    : getTimeElapsed(transaction)

  // Get amount from new model (already has token symbol appended)
  const amount = `${transaction.amount} ${transaction.tokenSymbol}`

  // Get status badge and icon classes using helper functions
  const badgeClasses = getStatusBadgeClasses(transaction)
  const iconClasses = getTransactionIconClasses(transaction)

  // Get chain display name
  const chainName = getChainDisplayName(transaction)

  return (
    <>
      <div
        className={cn(
          'card',
          variant === 'compact' 
            ? 'card-sm card-no-border' 
            : 'card-no-border',
          onClick || showExpandButton ? 'cursor-pointer' : '',
        )}
        onClick={handleClick}
      >
        {/* Dashboard compact layout (when hideActions is true and variant is compact) */}
        {hideActions && variant === 'compact' ? (
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            {/* Column 1: Transaction - Type and source chain */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex-shrink-0">
                <TransactionTypeIcon
                  direction={direction}
                  iconBgColor={iconClasses.bg}
                  iconTextColor={iconClasses.text}
                />
              </div>

              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium capitalize truncate">
                  {getFlowTypeLabel(transaction.flowType)}
                </span>
                <TransactionAddressRow
                  addressDisplayInfo={addressDisplayInfo}
                  direction={direction}
                />
              </div>
            </div>

            {/* Column 2: Amount and chain */}
            <TransactionAmountDisplay
              amount={amount}
              chainName={chainName}
              layout="vertical"
            />

            {/* Column 3: Status and time - stacked vertically */}
            <div className="flex flex-col items-end gap-1 min-w-0">
              <TransactionStatusBadge
                statusLabel={statusLabel}
                hasTimeout={false}
                timeoutMessage={undefined}
                size="sm"
                variant="rounded-sm"
                badgeClasses={badgeClasses}
              />
              
              <TransactionTimeDisplay
                timeElapsed={timeDisplay}
                size="sm"
              />
              
              {isInProgress(transaction) && (
                <TransactionProgressBar
                  progress={progress}
                  maxWidth="max-w-24"
                  height="sm"
                />
              )}
            </div>
          </div>
        ) : (
          <div className={cn(
            'grid items-center',
            hideActions ? 'grid-cols-[1fr_1fr]' : 'grid-cols-[1fr_1fr_1fr_auto]',
            variant === 'compact' ? 'gap-3' : 'gap-4'
          )}>
            {/* Column 1: Transaction - Type and source chain */}
            <div className="flex items-center gap-4 min-w-0">
              <div className="flex-shrink-0">
                <TransactionTypeIcon
                  direction={direction}
                  iconBgColor={iconClasses.bg}
                  iconTextColor={iconClasses.text}
                />
              </div>

              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium capitalize truncate">
                  {getFlowTypeLabel(transaction.flowType)}
                </span>
                <TransactionAddressRow
                  addressDisplayInfo={addressDisplayInfo}
                  direction={direction}
                />
              </div>
            </div>

            {/* Column 2: Amount & Status - Amount, chain, status and progress */}
            <div className="flex flex-col gap-2 min-w-0">
              <TransactionAmountDisplay
                amount={amount}
                chainName={chainName}
                layout="horizontal"
              />
              
              <div className="flex flex-col gap-1 min-w-0">
                <TransactionStatusBadge
                  statusLabel={statusLabel}
                  hasTimeout={false}
                  timeoutMessage={undefined}
                  size="md"
                  variant="rounded-md"
                  badgeClasses={badgeClasses}
                />

                {isInProgress(transaction) && (
                  <TransactionProgressBar
                    progress={progress}
                    maxWidth="max-w-48"
                    height="md"
                  />
                )}
              </div>
            </div>

            {/* Column 3: Time - Only shown in detailed view when actions are visible */}
            {!hideActions && (
              <TransactionTimeDisplay
                timeElapsed={timeDisplay}
                size="md"
              />
            )}

            {/* Column 4: Actions - Action icons */}
            {!hideActions && (
              <div className="flex items-center gap-2 flex-shrink-0">
                {onDelete && (
                  <DropdownMenu
                    trigger={
                      <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
                        aria-label="Transaction actions"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    }
                    align="right"
                  >
                    <DropdownMenuItem
                      onClick={() => {
                        setIsDeleteDialogOpen(true)
                      }}
                      stopPropagation
                      className="text-destructive hover:bg-destructive/10"
                    >
                      <div className="flex items-center gap-2">
                        <Trash2 className="h-4 w-4" />
                        <span>Delete</span>
                      </div>
                    </DropdownMenuItem>
                  </DropdownMenu>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {/* Render modal if showExpandButton is true - handles both internal and external state control */}
      {showExpandButton && (
        <TransactionDetailModal
          transaction={transaction}
          open={isModalOpen}
          onClose={() => setIsModalOpen(false)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {onDelete && (
        <DeleteTransactionConfirmationDialog
          open={isDeleteDialogOpen}
          onClose={() => setIsDeleteDialogOpen(false)}
          onConfirm={handleDeleteConfirm}
          transactionType={direction}
        />
      )}
    </>
  )
})
