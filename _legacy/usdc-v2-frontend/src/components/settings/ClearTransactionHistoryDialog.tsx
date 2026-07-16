import { X, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/common/Button'

interface ClearTransactionHistoryDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
}

export function ClearTransactionHistoryDialog({
  open,
  onClose,
  onConfirm,
}: ClearTransactionHistoryDialogProps) {
  if (!open) return null

  const handleConfirm = () => {
    onConfirm()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-overlay backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Content */}
      <div className="relative z-50 w-full max-w-md rounded-xl border border-error/20 bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        {/* Header with warning accent */}
        <div className="rounded-t-xl border-b border-error/20 bg-error/10 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-error/20">
                <AlertTriangle className="h-5 w-5 text-error" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">Clear Transaction History</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Close modal"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Warning Message */}
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-foreground">
              Clear transaction history?
            </p>
            <div className="flex items-start gap-2 rounded-lg border border-error/20 bg-error/10 p-3">
              <AlertTriangle className="h-4 w-4 text-error flex-shrink-0 mt-0.5" />
              <p className="text-sm font-medium text-error-foreground">
                Warning: This can't be undone!
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 justify-end pt-2">
            <Button 
              variant="ghost" 
              onClick={onClose}
              className="min-w-[80px]"
            >
              Cancel
            </Button>
            <Button 
              onClick={handleConfirm} 
              className="min-w-[80px] bg-error hover:bg-error/90 text-error-foreground border-0 focus:ring-error/50"
            >
              Clear
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
