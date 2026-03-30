// ABOUTME: Shared transaction state UI component.
// ABOUTME: Displays pending, submitted, confirmed, and error states for contract writes.

import type { TxState } from '@/hooks/useTransactionFlow'

export interface TransactionFlowProps {
  state: TxState
  onReset: () => void
  successMessage?: string
  explorerUrl?: string
}

export function TransactionFlow(props: TransactionFlowProps) {
  const { state, onReset, successMessage = 'Transaction confirmed!', explorerUrl } = props

  if (state.status === 'idle') return null

  return (
    <div className="rounded-lg border border-border p-4 space-y-2">
      {state.status === 'pending' && (
        <div className="flex items-center gap-2">
          <span className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
          <span className="text-sm">Waiting for wallet confirmation...</span>
        </div>
      )}

      {state.status === 'submitted' && (
        <div className="flex items-center gap-2">
          <span className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
          <span className="text-sm">Transaction submitted. Waiting for confirmation...</span>
          {state.txHash && (
            explorerUrl ? (
              <a
                href={`${explorerUrl}/tx/${state.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline font-mono"
              >
                {state.txHash.slice(0, 10)}...
              </a>
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {state.txHash.slice(0, 10)}...
              </span>
            )
          )}
        </div>
      )}

      {state.status === 'confirmed' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-success">
            <span className="text-sm font-medium">{successMessage}</span>
          </div>
          {state.txHash && explorerUrl && (
            <a
              href={`${explorerUrl}/tx/${state.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline font-mono"
            >
              View on explorer
            </a>
          )}
          <button
            className="text-xs text-primary hover:underline"
            onClick={onReset}
          >
            Dismiss
          </button>
        </div>
      )}

      {state.status === 'error' && (
        <div className="space-y-2">
          <div className="text-sm text-destructive">{state.error}</div>
          <button
            className="text-xs text-primary hover:underline"
            onClick={onReset}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
