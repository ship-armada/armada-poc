import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/common/Button'

interface TransactionErrorDisplayProps {
  error: { message: string }
  onRetry: () => void
}

/**
 * Generic transaction error display component.
 * Shows error message with a retry button for failed transactions.
 */
export function TransactionErrorDisplay({ error, onRetry }: TransactionErrorDisplayProps) {
  return (
    <div className="rounded-lg border border-error/50 bg-error/10 p-4 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-error shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold text-error mb-1">Transaction Failed</h3>
          <p className="text-sm text-error/90 mb-3">{error.message}</p>
          <Button variant="secondary" onClick={onRetry} className="h-8 text-sm">
            Try Again
          </Button>
        </div>
      </div>
    </div>
  )
}

