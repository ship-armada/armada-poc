import { Link } from 'react-router-dom'
import { Button } from '@/components/common/Button'
import { TxInProgressList } from '@/components/tx/TxInProgressList'
import { TxHistoryList } from '@/components/tx/TxHistoryList'

export interface RecentActivitySectionProps {
  /** Currently open modal transaction ID (optional, for external control) */
  openModalTxId?: string | null
  /** Callback when modal open state changes (optional, for external control) */
  onModalOpenChange?: (txId: string | null) => void
  /** Reload trigger for history section */
  reloadTrigger?: number
}

/**
 * Recent activity section component
 *
 * Displays in-progress and completed Privacy Pool transactions.
 */
export function RecentActivitySection({
  openModalTxId,
  onModalOpenChange,
  reloadTrigger,
}: RecentActivitySectionProps) {
  return (
    <div className="flex-5 card">
      {/* Section Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-md font-semibold">Recent activity</h2>
        <Link to="/history">
          <Button variant="ghost" className="h-6 px-2 text-xs">
            View All
          </Button>
        </Link>
      </div>

      {/* In Progress Section */}
      <div className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          In Progress
        </h2>
        <TxInProgressList
          openModalTxId={openModalTxId}
          onModalOpenChange={onModalOpenChange}
          hideActions
        />
      </div>

      {/* History Section */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          History
        </h2>
        <TxHistoryList
          openModalTxId={openModalTxId}
          onModalOpenChange={onModalOpenChange}
          reloadTrigger={reloadTrigger}
          hideActions
        />
      </div>
    </div>
  )
}
