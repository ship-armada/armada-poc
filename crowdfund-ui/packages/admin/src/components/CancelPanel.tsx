// ABOUTME: Security council cancel panel with typed confirmation gate.
// ABOUTME: Requires typing "CANCEL" to enable the cancel button — irreversible action.

import { useState } from 'react'
import { Contract } from 'ethers'
import type { Signer } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS } from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface CancelPanelProps {
  signer: Signer | null
  crowdfundAddress: string
}

export function CancelPanel({ signer, crowdfundAddress }: CancelPanelProps) {
  const [confirmation, setConfirmation] = useState('')
  const tx = useTransactionFlow(signer)
  const confirmed = confirmation === 'CANCEL'

  const handleCancel = async () => {
    if (!confirmed) return
    await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.cancel()
    })
  }

  return (
    <div className="rounded border border-destructive/50 bg-destructive/10 p-3 space-y-2">
      <div className="text-sm font-medium text-destructive">Emergency Cancel</div>
      <div className="text-xs text-muted-foreground">
        This action is irreversible. All commitments become refundable. Type CANCEL to confirm.
      </div>
      <input
        type="text"
        placeholder="Type CANCEL to confirm"
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
        className="w-full rounded border border-destructive/50 bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-destructive"
      />
      <button
        className="w-full rounded bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
        disabled={!confirmed || tx.state.status === 'pending' || tx.state.status === 'submitted'}
        onClick={handleCancel}
      >
        Cancel Crowdfund
      </button>
      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="Crowdfund canceled." />
    </div>
  )
}
