import { useEffect, useState } from 'react'
import { Clock, ChevronDown, ChevronUp } from 'lucide-react'
import type { StoredTransaction } from '@/types/transaction'
import { TransactionDetailModalHeader } from './TransactionDetailModalHeader'
import { AddressDisplaySection } from './AddressDisplaySection'
import { TransactionHashCard } from './TransactionHashCard'
import { HorizontalProgressStepper } from './HorizontalProgressStepper'

// ============ Helper functions for new StoredTransaction model ============

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
 * Format duration from milliseconds
 */
function formatDuration(durationMs: number): string {
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
 * Get total duration label
 */
function getTotalDurationLabel(tx: StoredTransaction): string {
  const durationMs = tx.updatedAt - tx.createdAt
  return formatDuration(durationMs)
}

/**
 * Get source chain name
 */
function getSourceChainName(tx: StoredTransaction): string {
  switch (tx.flowType) {
    case 'shield':
      // Shield comes from public address on source chain
      return tx.sourceChain.charAt(0).toUpperCase() + tx.sourceChain.slice(1)
    case 'transfer':
    case 'unshield':
      // Transfer/unshield comes from shielded wallet (always hub)
      return 'Shielded'
    default:
      return tx.sourceChain
  }
}

/**
 * Get destination chain name
 */
function getDestinationChainName(tx: StoredTransaction): string {
  switch (tx.flowType) {
    case 'shield':
      // Shield goes to shielded wallet
      return 'Shielded'
    case 'transfer':
      // Transfer goes to another shielded wallet
      return 'Shielded'
    case 'unshield':
      // Unshield goes to public address on destination chain
      const destChain = tx.destinationChain || 'hub'
      return destChain.charAt(0).toUpperCase() + destChain.slice(1)
    default:
      return tx.destinationChain || 'Unknown'
  }
}

/**
 * Get sender address based on flow type
 */
function getSenderAddress(tx: StoredTransaction): string | undefined {
  switch (tx.flowType) {
    case 'shield':
      return tx.publicAddress
    case 'transfer':
    case 'unshield':
      return tx.railgunAddress
    default:
      return undefined
  }
}

/**
 * Get receiver address based on flow type
 */
function getReceiverAddress(tx: StoredTransaction): string | undefined {
  switch (tx.flowType) {
    case 'shield':
      return tx.railgunAddress
    case 'transfer':
    case 'unshield':
      return tx.recipientAddress
    default:
      return undefined
  }
}

/**
 * Get the main transaction hash
 */
function getMainTxHash(tx: StoredTransaction): string | undefined {
  return tx.txHashes.main
}

/**
 * Get relay transaction hash (for cross-chain)
 */
function getRelayTxHash(tx: StoredTransaction): string | undefined {
  return tx.txHashes.relay
}

/**
 * Get transaction status string
 */
function getTxStatus(tx: StoredTransaction): 'pending' | 'confirmed' | 'failed' {
  switch (tx.status) {
    case 'success':
      return 'confirmed'
    case 'error':
      return 'failed'
    default:
      return 'pending'
  }
}

export interface TransactionDetailModalProps {
  transaction: StoredTransaction
  open: boolean
  onClose: () => void
}

export function TransactionDetailModal({
  transaction,
  open,
  onClose,
}: TransactionDetailModalProps) {
  const [isStageTimelineExpanded, setIsStageTimelineExpanded] = useState(false)
  const [showSenderAddress, setShowSenderAddress] = useState(false)
  const [showReceiverAddress, setShowReceiverAddress] = useState(false)

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

  const statusLabel = getStatusLabel(transaction)
  const totalDuration = getTotalDurationLabel(transaction)

  // Format started at timestamp
  const startedAt = new Date(transaction.createdAt).toLocaleString()

  // Get amount from new model
  const amount = transaction.amount

  // Get addresses using helper functions
  const senderAddress = getSenderAddress(transaction)
  const receiverAddress = getReceiverAddress(transaction)

  // Get chain names
  const sourceChainName = getSourceChainName(transaction)
  const destinationChainName = getDestinationChainName(transaction)

  // Get transaction hashes
  const mainTxHash = getMainTxHash(transaction)
  const relayTxHash = getRelayTxHash(transaction)

  // Get transaction status
  const txStatus = getTxStatus(transaction)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-overlay backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Content */}
      <div className="relative z-50 w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-lg border border-border bg-background shadow-lg">
        {/* Header */}
        <TransactionDetailModalHeader
          transaction={transaction}
          statusLabel={statusLabel}
          startedAt={startedAt}
          onClose={onClose}
        />

        {/* Content */}
        <div className="p-6 pt-2 space-y-6">
          {/* First Row: Sender, Receiver, Amount, Duration */}
          <div className="grid grid-cols-4 gap-4">
            {senderAddress && (
              <div className="bg-muted p-4 rounded-md">
                <AddressDisplaySection
                  address={senderAddress}
                  label={`From ${sourceChainName}`}
                  explorerUrl={undefined}
                  isSender={true}
                  showAddress={showSenderAddress}
                  onToggleShowAddress={() => setShowSenderAddress(!showSenderAddress)}
                  transaction={transaction}
                />
              </div>
            )}
            {receiverAddress && (
              <div className="bg-muted p-4 rounded-md">
                <AddressDisplaySection
                  address={receiverAddress}
                  label={`To ${destinationChainName}`}
                  explorerUrl={undefined}
                  isSender={false}
                  showAddress={showReceiverAddress}
                  onToggleShowAddress={() => setShowReceiverAddress(!showReceiverAddress)}
                  transaction={transaction}
                />
              </div>
            )}
            {amount && (
              <div className="bg-muted p-4 rounded-md">
                <div className="space-y-1">
                  <dt className="text-sm text-muted-foreground">Amount</dt>
                  <dd>
                    <div className="flex items-center gap-2">
                      <img
                        src="/assets/logos/usdc-logo.svg"
                        alt="USDC"
                        className="h-5 w-5 flex-shrink-0"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                      <span className="text-md font-medium">{amount} {transaction.tokenSymbol}</span>
                    </div>
                  </dd>
                </div>
              </div>
            )}
            <div className="bg-muted p-4 rounded-md">
              <div className="space-y-1">
                <dt className="text-sm capitalize text-muted-foreground">{transaction.flowType} Duration</dt>
                <dd>
                  <div className="flex items-center gap-2">
                    <Clock className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <span className="text-md font-medium">{totalDuration}</span>
                  </div>
                </dd>
              </div>
            </div>
          </div>

          {/* Horizontal Progress Stepper */}
          {transaction.stages.length > 0 && (
            <div className="py-2">
              <HorizontalProgressStepper transaction={transaction} />
            </div>
          )}

          {/* Source and Destination Transactions */}
          <div className="grid grid-cols-2 gap-4">
            <TransactionHashCard
              label="Main Transaction"
              txHash={mainTxHash}
              status={txStatus}
              explorerUrl={undefined}
            />
            {transaction.isCrossChain && (
              <TransactionHashCard
                label="Relay Transaction"
                txHash={relayTxHash}
                status={relayTxHash ? 'confirmed' : 'pending'}
                explorerUrl={undefined}
              />
            )}
          </div>

          {/* Error Message */}
          {transaction.errorMessage && (
            <div className="border border-error/30 bg-error/10 p-4 rounded-md">
              <div className="flex items-start gap-2">
                <div>
                  <p className="text-sm font-medium text-error">
                    Error
                  </p>
                  <p className="mt-1 text-sm text-error/90">
                    {transaction.errorMessage}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Stage Timeline (expandable) */}
          {transaction.stages.length > 0 && (
            <div className="space-y-4">
              <button
                type="button"
                onClick={() => setIsStageTimelineExpanded(!isStageTimelineExpanded)}
                className="flex w-full bg-muted rounded-md justify-between p-3 items-center gap-2 text-md text-foreground hover:text-foreground transition-colors"
              >
                <span>Event Log</span>
                {isStageTimelineExpanded ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>
              {isStageTimelineExpanded && (
                <div className="space-y-3">
                  {/* Tracking Status */}
                  <div className="flex items-center justify-start gap-4 pb-3 border-b border-border">
                    <div className="flex flex-col text-xs">
                      <span className="text-muted-foreground font-semibold">Status</span>
                      <span className="text-muted-foreground">
                        Last updated: {new Date(transaction.updatedAt).toLocaleString()}
                      </span>
                    </div>
                    {transaction.status === 'success' && (
                      <span className="inline-flex items-center rounded-full bg-success/10 px-2 py-1 text-xs font-medium text-success">
                        Success
                      </span>
                    )}
                    {transaction.status === 'error' && (
                      <span className="inline-flex items-center rounded-full bg-error/10 px-2 py-1 text-xs font-medium text-error">
                        Failed
                      </span>
                    )}
                    {transaction.status === 'pending' && (
                      <span className="inline-flex items-center rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                        In Progress
                      </span>
                    )}
                  </div>
                  {/* Stage list */}
                  {transaction.stages.map((stage, index) => {
                    const isLast = index === transaction.stages.length - 1
                    return (
                      <div
                        key={`${stage.id}-${index}`}
                        className={`flex items-start gap-3 ${!isLast ? 'pb-3 border-b border-border/50' : ''}`}
                      >
                        <div className={`w-2 h-2 mt-1.5 rounded-full flex-shrink-0 ${
                          stage.status === 'confirmed' ? 'bg-success' :
                          stage.status === 'active' ? 'bg-primary animate-pulse' :
                          stage.status === 'error' ? 'bg-error' :
                          'bg-muted-foreground/30'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{stage.label}</span>
                            {stage.timestamp && (
                              <span className="text-xs text-muted-foreground">
                                {new Date(stage.timestamp).toLocaleTimeString()}
                              </span>
                            )}
                          </div>
                          {stage.message && (
                            <p className="text-xs text-muted-foreground mt-0.5">{stage.message}</p>
                          )}
                          {stage.txHash && (
                            <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                              tx: {stage.txHash}
                            </p>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

