import { useState, useCallback } from 'react'
import { AlertTriangle, Download } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Tooltip } from '@/components/common/Tooltip'
import { TransactionCard } from '@/components/tx/TransactionCard'
import { TransactionDetailModal } from '@/components/tx/TransactionDetailModal'
import { useTransactionHistory } from '@/hooks/useTransactionHistory'
import type { StoredTransaction } from '@/types/transaction'

const FILTERS = ['all', 'shield', 'transfer', 'unshield'] as const
type FilterType = (typeof FILTERS)[number]

export function History() {
  const [activeFilter, setActiveFilter] = useState<FilterType>('all')
  const { transactions } = useTransactionHistory()
  const [selectedTx, setSelectedTx] = useState<StoredTransaction | null>(null)

  // Filter transactions based on active filter
  const filteredTransactions = transactions.filter((tx) => {
    if (activeFilter === 'all') {
      return true
    }
    return tx.flowType === activeFilter
  })

  const handleTransactionClick = useCallback((tx: StoredTransaction) => {
    setSelectedTx(tx)
  }, [])

  const handleCloseModal = useCallback(() => {
    setSelectedTx(null)
  }, [])

  const getFilterLabel = (filter: FilterType): string => {
    switch (filter) {
      case 'all':
        return 'All Activity'
      case 'shield':
        return 'Shields'
      case 'transfer':
        return 'Transfers'
      case 'unshield':
        return 'Unshields'
    }
  }

  const getEmptyMessage = (): string => {
    switch (activeFilter) {
      case 'all':
        return 'No transactions found. Your transaction history will appear here.'
      case 'shield':
        return 'No shield transactions found.'
      case 'transfer':
        return 'No transfer transactions found.'
      case 'unshield':
        return 'No unshield transactions found.'
    }
  }

  return (
    <div className="container space-y-6 p-12 mx-auto w-full">
      <header className="space-y-2">
        <p className="text-muted-foreground">
          Review your recent transaction activity
        </p>
      </header>

      {/* Filters Section */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <Button
              key={filter}
              variant={activeFilter === filter ? 'primary' : 'ghost'}
              onClick={() => setActiveFilter(filter)}
              className="transition-all rounded-xl"
            >
              {getFilterLabel(filter)}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex">
            <Tooltip
              content="History is only available on this device. Browser storage can be volatile so this page serves as a reference only; assume any info here can be lost unless backed up independently."
              side="top"
              className="whitespace-normal max-w-md"
            >
              <div className="flex gap-2">
                <AlertTriangle className="h-5 w-5 text-warning flex-shrink-0" />
                <span className="text-sm font-semibold text-warning">Important</span>
              </div>
            </Tooltip>
          </div>
          <Tooltip
            content="TODO: Add CSV export functionality for transaction history."
            side="top"
            className="whitespace-normal max-w-xs"
          >
            <Button variant="ghost" className="ml-auto rounded-xl" disabled>
              <Download className="h-4 w-4" />
              Export History
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Transaction List */}
      {filteredTransactions.length === 0 ? (
        <div className="card card-3xl text-center">
          <p className="text-base text-muted-foreground">{getEmptyMessage()}</p>
        </div>
      ) : (
        <div className="card card-xl">
          {/* Column Headers */}
          <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-4 pb-4 mb-4 border-b border-border">
            <div className="text-sm font-semibold text-muted-foreground">
              Transaction
              <span className="text-xs font-normal ml-1">(click for details)</span>
            </div>
            <div className="text-sm font-semibold text-muted-foreground">Amount & Status</div>
            <div></div>
            <div className="text-sm font-semibold text-muted-foreground">Actions</div>
          </div>

          <div className="space-y-2">
            {filteredTransactions.map((tx) => (
              <TransactionCard
                key={tx.id}
                transaction={tx}
                variant="compact"
                showExpandButton={false}
                onClick={() => handleTransactionClick(tx)}
              />
            ))}
          </div>
        </div>
      )}
      <div className="min-h-12" />

      {/* Transaction Detail Modal */}
      {selectedTx && (
        <TransactionDetailModal
          transaction={selectedTx}
          open={!!selectedTx}
          onClose={handleCloseModal}
        />
      )}
    </div>
  )
}
