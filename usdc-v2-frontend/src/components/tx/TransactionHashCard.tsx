import { CheckCircle2, Clock, XCircle } from 'lucide-react'
import { ExplorerLink } from '@/components/common/ExplorerLink'
import { CopyButton } from '@/components/common/CopyButton'
import { formatTxHash } from '@/utils/toastHelpers'

export interface TransactionHashCardProps {
  label: string
  txHash: string | undefined
  status: 'success' | 'confirmed' | 'pending' | 'failed'
  explorerUrl?: string
}

export function TransactionHashCard({
  label,
  txHash,
  status,
  explorerUrl,
}: TransactionHashCardProps) {
  // Normalize status for display
  const isConfirmed = status === 'success' || status === 'confirmed'
  const isFailed = status === 'failed'

  return (
    <div className="bg-muted p-4 rounded-md">
      <div className="space-y-3">
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <dd>
          <div className="flex items-center gap-2">
            {isConfirmed ? (
              <CheckCircle2 className="h-5 w-5 text-success flex-shrink-0" />
            ) : isFailed ? (
              <XCircle className="h-5 w-5 text-error flex-shrink-0" />
            ) : (
              <Clock className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            )}
            {txHash ? (
              <>
                <span className="text-sm font-mono">{formatTxHash(txHash)}</span>
                <div className="flex items-center gap-1">
                  <CopyButton
                    text={txHash}
                    label={label}
                    size="md"
                  />
                  {explorerUrl && (
                    <ExplorerLink
                      url={explorerUrl}
                      label={`Open ${label} in explorer`}
                      size="md"
                      iconOnly
                      className="explorer-link-inline"
                    />
                  )}
                </div>
              </>
            ) : (
              <span className="text-sm">Pending...</span>
            )}
          </div>
        </dd>
      </div>
    </div>
  )
}

