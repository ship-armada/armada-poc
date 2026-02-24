/**
 * Privacy Pool Transaction Detail Modal
 *
 * Shows detailed information about a Privacy Pool transaction including
 * the full stage timeline, addresses, and transaction hashes.
 */

import { useState, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowRightLeft,
  X,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
} from 'lucide-react'
import type { StoredTransaction, FlowType, TxStatus } from '@/types/transaction'
import { chainConfigAtom } from '@/atoms/appAtom'
import { getChainDisplayName } from '@/config/chains'
import { buildExplorerUrlSync } from '@/utils/explorerUtils'
import { PrivacyPoolTimeline } from './PrivacyPoolTimeline'
import { CopyButton } from '@/components/common/CopyButton'
import { ExplorerLink } from '@/components/common/ExplorerLink'
import { repairTransaction } from '@/services/tx'

// ============ Types ============

export interface PrivacyPoolTxDetailModalProps {
  /** The transaction to display, or null if closed */
  transaction: StoredTransaction | null
  /** Whether the modal is open */
  isOpen: boolean
  /** Callback to close the modal */
  onClose: () => void
  /** Callback after repair (to refresh parent state) */
  onRepair?: (tx: StoredTransaction) => void
}

// ============ Helper: Check if transaction can be repaired ============

function canRepair(tx: StoredTransaction): boolean {
  // For debugging: show repair button for all completed transactions
  // TODO: Revert to only showing when stages need repair after debugging
  return tx.status === 'success'
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

function getFlowTitle(flowType: FlowType): string {
  switch (flowType) {
    case 'shield':
      return 'Shield Transaction'
    case 'unshield':
      return 'Unshield Transaction'
    case 'transfer':
      return 'Private Transfer'
    default:
      return 'Transaction'
  }
}

function getStatusIcon(status: TxStatus) {
  switch (status) {
    case 'success':
      return <CheckCircle2 className="h-5 w-5 text-success" />
    case 'error':
      return <XCircle className="h-5 w-5 text-error" />
    case 'cancelled':
      return <XCircle className="h-5 w-5 text-muted-foreground" />
    case 'pending':
      return <Clock className="h-5 w-5 text-primary animate-pulse" />
    default:
      return <Clock className="h-5 w-5 text-muted-foreground" />
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

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function formatDuration(startMs: number, endMs?: number): string {
  const end = endMs || Date.now()
  const durationMs = end - startMs
  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

function formatAddress(address: string, short: boolean = true): string {
  if (!address) return ''
  if (!short) return address
  if (address.length <= 16) return address
  return `${address.slice(0, 10)}...${address.slice(-6)}`
}

function formatTxHash(hash: string): string {
  if (!hash) return ''
  if (hash.length <= 20) return hash
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`
}

// ============ Sub-components ============

interface AddressRowProps {
  label: string
  address?: string
  isRailgun?: boolean
  explorerUrl?: string
}

function AddressRow({ label, address, isRailgun = false, explorerUrl }: AddressRowProps) {
  if (!address) return null

  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`text-sm font-mono truncate ${isRailgun ? 'text-primary' : ''}`}
          title={address}
        >
          {formatAddress(address)}
        </span>
        <CopyButton text={address} size="sm" />
        {explorerUrl && (
          <ExplorerLink url={explorerUrl} label={`View address in explorer`} size="sm" iconOnly />
        )}
      </div>
    </div>
  )
}

interface TxHashRowProps {
  label: string
  hash?: string
  explorerUrl?: string
}

function TxHashRow({ label, hash, explorerUrl }: TxHashRowProps) {
  if (!hash) return null

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono">{formatTxHash(hash)}</span>
        <CopyButton text={hash} size="sm" />
        {explorerUrl && (
          <ExplorerLink url={explorerUrl} label={`View ${label.toLowerCase()} tx in explorer`} size="sm" iconOnly />
        )}
      </div>
    </div>
  )
}

// ============ Main Component ============

export function PrivacyPoolTxDetailModal({
  transaction,
  isOpen,
  onClose,
  onRepair,
}: PrivacyPoolTxDetailModalProps) {
  const chainConfig = useAtomValue(chainConfigAtom)
  const [isRepairing, setIsRepairing] = useState(false)
  const [localTx, setLocalTx] = useState<StoredTransaction | null>(null)

  // Reset local state when transaction changes or modal closes
  useEffect(() => {
    setLocalTx(null)
    setIsRepairing(false)
  }, [transaction?.id, isOpen])

  // Use local state if we've repaired, otherwise use prop
  const displayTx = localTx || transaction

  if (!isOpen || !displayTx) {
    return null
  }

  const {
    flowType,
    status,
    amount,
    tokenSymbol,
    sourceChain,
    destinationChain,
    isCrossChain,
    publicAddress,
    railgunAddress,
    recipientAddress,
    txHashes,
    createdAt,
    updatedAt,
    errorMessage,
  } = displayTx

  const showRepairButton = canRepair(displayTx)

  const handleRepair = () => {
    if (!displayTx) return
    setIsRepairing(true)
    try {
      const repaired = repairTransaction(displayTx.id)
      if (repaired) {
        setLocalTx(repaired)
        onRepair?.(repaired)
      }
    } finally {
      setIsRepairing(false)
    }
  }

  // Build explorer URLs for addresses and tx hashes
  const evmConfig = chainConfig ?? null
  const buildAddrUrl = (addr: string | undefined, chainKey: string) =>
    addr && !addr.startsWith('0zk')
      ? buildExplorerUrlSync(addr, 'address', 'evm', chainKey, evmConfig)
      : undefined
  const buildTxUrl = (hash: string | undefined, chainKey: string) =>
    hash ? buildExplorerUrlSync(hash, 'tx', 'evm', chainKey, evmConfig) : undefined

  // Determine addresses to display based on flow type
  const getAddressDisplay = () => {
    switch (flowType) {
      case 'shield':
        return (
          <>
            <AddressRow label="From (Public)" address={publicAddress} explorerUrl={buildAddrUrl(publicAddress, sourceChain)} />
            <AddressRow label="To (Shielded)" address={railgunAddress} isRailgun />
          </>
        )
      case 'transfer':
        return (
          <>
            <AddressRow label="From (Shielded)" address={railgunAddress} isRailgun />
            <AddressRow label="To (Shielded)" address={recipientAddress} isRailgun />
          </>
        )
      case 'unshield':
        return (
          <>
            <AddressRow label="From (Shielded)" address={railgunAddress} isRailgun />
            <AddressRow label="To (Public)" address={recipientAddress} explorerUrl={buildAddrUrl(recipientAddress, destinationChain ?? 'hub')} />
          </>
        )
      default:
        return null
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-background border border-border rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-background border-b border-border p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-full ${
                status === 'success'
                  ? 'bg-success/10 text-success'
                  : status === 'error'
                    ? 'bg-error/10 text-error'
                    : status === 'pending'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
              }`}
            >
              {getFlowIcon(flowType)}
            </div>
            <div>
              <h2 className="font-semibold">{getFlowTitle(flowType)}</h2>
              <div className={`flex items-center gap-1.5 text-sm ${getStatusColor(status)}`}>
                {getStatusIcon(status)}
                <span>{getStatusLabel(status)}</span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-muted rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-6">
          {/* Amount */}
          <div className="text-center py-4 border-b border-border">
            <div className="text-3xl font-bold font-mono">
              {parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </div>
            <div className="text-muted-foreground">{tokenSymbol}</div>
          </div>

          {/* Addresses */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Addresses</h3>
            <div className="space-y-2">{getAddressDisplay()}</div>
          </div>

          {/* Chain Info */}
          {(sourceChain || destinationChain) && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Chain</h3>
              <div className="flex items-center gap-2 text-sm">
                <span>{getChainDisplayName(chainConfig, sourceChain)}</span>
                {isCrossChain && destinationChain && destinationChain !== sourceChain && (
                  <>
                    <span className="text-muted-foreground">→</span>
                    <span>{getChainDisplayName(chainConfig, destinationChain)}</span>
                  </>
                )}
                {isCrossChain && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    Cross-chain
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Timeline */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Progress</h3>
              {showRepairButton && (
                <button
                  onClick={handleRepair}
                  disabled={isRepairing}
                  className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors disabled:opacity-50"
                  title="Fix incomplete stage statuses"
                >
                  <RefreshCw className={`h-3 w-3 ${isRepairing ? 'animate-spin' : ''}`} />
                  {isRepairing ? 'Repairing...' : 'Repair Timeline'}
                </button>
              )}
            </div>
            <div className="pl-2">
              <PrivacyPoolTimeline transaction={displayTx} />
            </div>
          </div>

          {/* Transaction Hashes */}
          {(txHashes.approval || txHashes.main || txHashes.relay) && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Transaction Hashes</h3>
              <div className="space-y-2">
                <TxHashRow label="Approval" hash={txHashes.approval} explorerUrl={buildTxUrl(txHashes.approval, sourceChain)} />
                <TxHashRow label="Main" hash={txHashes.main} explorerUrl={buildTxUrl(txHashes.main, flowType === 'shield' ? sourceChain : 'hub')} />
                <TxHashRow label="Relay" hash={txHashes.relay} explorerUrl={buildTxUrl(txHashes.relay, destinationChain ?? 'hub')} />
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Timing</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Started</span>
                <span>{formatTimestamp(createdAt)}</span>
              </div>
              {status !== 'pending' && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Completed</span>
                  <span>{formatTimestamp(updatedAt)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Duration</span>
                <span>
                  {formatDuration(createdAt, status !== 'pending' ? updatedAt : undefined)}
                </span>
              </div>
            </div>
          </div>

          {/* Error Message */}
          {errorMessage && (
            <div className="p-3 rounded bg-error/10 border border-error/20">
              <h3 className="text-sm font-medium text-error mb-1">Error</h3>
              <p className="text-sm text-error/80">{errorMessage}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
