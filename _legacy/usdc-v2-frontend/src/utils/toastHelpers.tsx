import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Info,
  Loader2,
  Copy,
} from 'lucide-react'
import type { ToastArgs, ToastActionButton } from '@/hooks/useToast'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import { TOAST_DURATION } from '@/config/constants'
import { getShortErrorMessage } from '@/utils/errorSanitizer'

/**
 * Format transaction hash for display
 */
export function formatTxHash(hash: string, startChars = 8, endChars = 6): string {
  if (hash.length <= startChars + endChars) return hash
  return `${hash.slice(0, startChars)}...${hash.slice(-endChars)}`
}

/**
 * Format address for display
 */
export function formatAddress(address: string, startChars = 6, endChars = 4): string {
  if (address.length <= startChars + endChars) return address
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`
}

/**
 * Get icon for toast level
 */
export function getToastIcon(level: ToastArgs['level'] = 'info') {
  switch (level) {
    case 'success':
      return <CheckCircle2 className="h-5 w-5 !text-success" />
    case 'error':
      return <XCircle className="h-5 w-5 !text-error" />
    case 'warning':
      return <AlertCircle className="h-5 w-5 !text-warning" />
    case 'loading':
      return <Loader2 className="h-5 w-5 !text-info animate-spin" />
    default:
      return <Info className="h-5 w-5 !text-info" />
  }
}

/**
 * Create a copy-to-clipboard action button
 */
export function createCopyAction(
  text: string,
  label: string = 'Copy',
  onSuccess?: () => void
): ToastActionButton {
  return {
    label,
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(text)
        onSuccess?.()
      } catch (error) {
        console.error('[toastHelpers] Failed to copy to clipboard:', error)
      }
    },
  }
}

/**
 * Create a view transaction action button
 */
export function createViewTransactionAction(
  transactionId: string,
  onView: (id: string) => void
): ToastActionButton {
  return {
    label: 'View Transaction',
    onClick: () => {
      onView(transactionId)
    },
  }
}

/**
 * Create an external link action button
 */
export function createExplorerLinkAction(
  url: string,
  label: string = 'View on Explorer'
): ToastActionButton {
  return {
    label,
    onClick: () => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
  }
}

/**
 * Build a transaction success toast
 */
export function buildTransactionSuccessToast(
  transaction: StoredTransaction,
  options: {
    onViewTransaction?: (id: string) => void
    onCopyHash?: () => void
    explorerUrl?: string
  } = {}
): ToastArgs {
  const txHash = transaction.hash
  const txHashDisplay = txHash ? formatTxHash(txHash) : 'Pending'
  const direction = transaction.direction === 'deposit' ? 'Deposit' : 'Payment'
  const title = `${direction} Submitted`
  const description = txHash
    ? `Transaction ${txHashDisplay} submitted successfully`
    : 'Transaction submitted successfully'

  const actions: ToastActionButton[] = []

  // Add view transaction action if callback provided
  if (options.onViewTransaction) {
    actions.push(createViewTransactionAction(transaction.id, options.onViewTransaction))
  }

  // Add copy hash action if hash exists
  if (txHash && options.onCopyHash !== undefined) {
    actions.push(
      createCopyAction(txHash, 'Copy Hash', options.onCopyHash)
    )
  }

  // Add explorer link if URL provided
  if (options.explorerUrl) {
    actions.push(createExplorerLinkAction(options.explorerUrl))
  }

  return {
    title,
    description,
    level: 'success',
    icon: getToastIcon('success'),
    duration: TOAST_DURATION.DEFAULT,
    action: actions[0], // Sonner supports one action, use the first one
    id: `tx-${transaction.id}`, // Use transaction ID for toast ID to allow updates
  }
}

/**
 * Build a transaction error toast
 */
export function buildTransactionErrorToast(
  transaction: StoredTransaction | { id: string; direction: 'deposit' | 'send' },
  errorMessage: string | unknown,
  options: {
    onViewTransaction?: (id: string) => void
    onRetry?: () => void
  } = {}
): ToastArgs {
  const direction = transaction.direction === 'deposit' ? 'Deposit' : 'Payment'
  const title = `${direction} Failed`
  const description = errorMessage ? getShortErrorMessage(errorMessage, 150) : 'Transaction failed. Please try again.'

  const actions: ToastActionButton[] = []

  // Add view transaction action if callback provided
  if (options.onViewTransaction && 'id' in transaction) {
    actions.push(createViewTransactionAction(transaction.id, options.onViewTransaction))
  }

  // Add retry action if callback provided
  if (options.onRetry) {
    actions.push({
      label: 'Retry',
      onClick: options.onRetry,
    })
  }

  return {
    title,
    description,
    level: 'error',
    icon: getToastIcon('error'),
    duration: TOAST_DURATION.LONG,
    action: actions[0],
    id: `tx-error-${transaction.id}`,
  }
}

/**
 * Build a transaction status update toast (for building, signing, submitting)
 */
export function buildTransactionStatusToast(
  stage: 'building' | 'signing' | 'submitting' | 'broadcasting',
  direction: 'deposit' | 'send',
  toastId?: string | number
): ToastArgs {
  const directionLabel = direction === 'deposit' ? 'Deposit' : 'Payment'
  const stageLabels = {
    building: 'Building transaction...',
    signing: 'Signing transaction...',
    submitting: 'Submitting transaction...',
    broadcasting: 'Broadcasting transaction...',
  }

  return {
    title: `${directionLabel} Transaction`,
    description: stageLabels[stage],
    level: 'loading',
    icon: getToastIcon('loading'),
    duration: TOAST_DURATION.PERSISTENT,
    id: toastId || `tx-${stage}-${Date.now()}`,
  }
}

/**
 * Build a wallet connection toast
 */
export function buildWalletConnectionToast(
  _walletType: 'metamask',
  account: string,
  isConnected: boolean
): ToastArgs {
  const walletName = 'MetaMask'
  const title = isConnected
    ? `${walletName} Connected`
    : `${walletName} Disconnected`
  const description = isConnected
    ? `Account: ${formatAddress(account)}`
    : 'Wallet disconnected'

  return {
    title,
    description,
    level: isConnected ? 'success' : 'info',
    icon: getToastIcon(isConnected ? 'success' : 'info'),
    duration: TOAST_DURATION.SHORT,
  }
}

/**
 * Build a copy success toast
 */
export function buildCopySuccessToast(label: string): ToastArgs {
  return {
    title: 'Copied',
    description: `${label} copied to clipboard`,
    level: 'success',
    icon: <Copy className="h-5 w-5 !text-success" />,
    duration: TOAST_DURATION.SHORT,
  }
}

/**
 * Build a copy error toast
 */
export function buildCopyErrorToast(): ToastArgs {
  return {
    title: 'Copy Failed',
    description: 'Failed to copy to clipboard',
    level: 'error',
    icon: getToastIcon('error'),
    duration: TOAST_DURATION.SHORT,
  }
}

/**
 * Build a shielding operation toast
 */
export function buildShieldingToast(
  phase: 'building' | 'signing' | 'submitting' | 'submitted',
  txHash?: string
): ToastArgs {
  const phaseLabels = {
    building: 'Building shielding transaction...',
    signing: 'Waiting for approval...',
    submitting: 'Submitting transaction...',
    submitted: txHash
      ? `Transaction submitted: ${formatTxHash(txHash)}`
      : 'Transaction submitted successfully',
  }

  const isComplete = phase === 'submitted'

  return {
    title: 'Shield',
    description: phaseLabels[phase],
    level: isComplete ? 'success' : 'loading',
    icon: isComplete ? getToastIcon('success') : getToastIcon('loading'),
    duration: isComplete ? TOAST_DURATION.DEFAULT : TOAST_DURATION.PERSISTENT,
    id: 'shielding-operation', // Use fixed ID to allow updates
  }
}

/**
 * Build a validation error toast
 */
export function buildValidationErrorToast(
  field: string,
  message: string
): ToastArgs {
  return {
    title: `Invalid ${field}`,
    description: message,
    level: 'error',
    icon: getToastIcon('error'),
    duration: TOAST_DURATION.SHORT,
  }
}

/**
 * Build a network change toast
 */
export function buildNetworkChangeToast(chainId: string | number): ToastArgs {
  return {
    title: 'Network Changed',
    description: `Chain ID: ${chainId}`,
    level: 'warning',
    icon: getToastIcon('warning'),
    duration: TOAST_DURATION.SHORT,
  }
}

