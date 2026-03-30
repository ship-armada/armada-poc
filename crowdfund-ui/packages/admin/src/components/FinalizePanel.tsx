// ABOUTME: Pre-finalization summary and finalize button.
// ABOUTME: Shows outcome preview and min-sale warning; permissionless after window ends.

import { Contract } from 'ethers'
import type { Signer } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  formatUsdc,
} from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface FinalizePanelProps {
  signer: Signer | null
  crowdfundAddress: string
  totalCommitted: bigint
  saleSize: bigint
}

export function FinalizePanel({ signer, crowdfundAddress, totalCommitted, saleSize }: FinalizePanelProps) {
  const tx = useTransactionFlow(signer)
  const belowMin = totalCommitted < CROWDFUND_CONSTANTS.MIN_SALE

  const handleFinalize = async () => {
    await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.finalize()
    })
  }

  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="text-sm font-medium">Finalize Crowdfund</div>
      <div className="text-xs space-y-1">
        <div>Total committed: {formatUsdc(totalCommitted)}</div>
        <div>Sale size: {formatUsdc(saleSize)}</div>
        {belowMin && (
          <div className="text-amber-500">
            Below minimum sale ({formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)}). Finalization will trigger refund mode.
          </div>
        )}
      </div>
      <button
        className="w-full rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={tx.state.status === 'pending' || tx.state.status === 'submitted'}
        onClick={handleFinalize}
      >
        Finalize
      </button>
      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="Crowdfund finalized!" />
    </div>
  )
}
