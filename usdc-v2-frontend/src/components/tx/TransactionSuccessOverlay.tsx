/**
 * Full-page success overlay component for transaction completion.
 * Shows success message, transaction hash, explorer link, and action buttons.
 */

import { CheckCircle2 } from 'lucide-react'
import { ExplorerLink } from '@/components/common/ExplorerLink'
import { formatTxHash } from '@/utils/toastHelpers'
import { cn } from '@/lib/utils'
import { Button } from '@/components/common/Button'

export interface TransactionSuccessOverlayProps {
  txHash: string
  explorerUrl?: string
  onNavigate: () => void
  onStartNewTransaction: () => void
  className?: string
}

export function TransactionSuccessOverlay({
  txHash,
  explorerUrl,
  onNavigate,
  onStartNewTransaction,
  className,
}: TransactionSuccessOverlayProps) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm animate-in fade-in duration-300",
        className
      )}
    >
      <div className="text-center space-y-6 px-6 max-w-md">
        <div className="animate-in zoom-in-95 duration-500">
          <CheckCircle2 className="h-16 w-16 text-success mx-auto" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold">Transaction Submitted!</h2>
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-center gap-2">
              <code className="text-sm font-mono text-muted-foreground bg-muted px-3 py-1.5 rounded">
                {formatTxHash(txHash)}
              </code>
            </div>
            {explorerUrl && (
              <ExplorerLink
                url={explorerUrl}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary/40"
              >
                View on Explorer
              </ExplorerLink>
            )}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <Button
            variant="outline"
            onClick={onNavigate}
            className="flex-1"
          >
            Return to Dashboard
          </Button>
          <Button
            onClick={onStartNewTransaction}
            className="flex-1"
          >
            Start Another Transaction
          </Button>
        </div>
      </div>
    </div>
  )
}

