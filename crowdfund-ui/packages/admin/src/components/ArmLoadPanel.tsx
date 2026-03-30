// ABOUTME: ARM pre-load verification panel.
// ABOUTME: Permissionless — anyone can call loadArm() to verify ARM token balance.

import { Contract } from 'ethers'
import type { Signer } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS } from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface ArmLoadPanelProps {
  signer: Signer | null
  crowdfundAddress: string
}

export function ArmLoadPanel({ signer, crowdfundAddress }: ArmLoadPanelProps) {
  const tx = useTransactionFlow(signer)

  const handleLoad = async () => {
    await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.loadArm()
    })
  }

  return (
    <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
      <div className="text-sm font-medium text-amber-500">ARM Not Loaded</div>
      <div className="text-xs text-muted-foreground">
        ARM tokens must be deposited and verified before the commitment window opens.
      </div>
      <button
        className="rounded bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
        onClick={handleLoad}
        disabled={tx.state.status === 'pending' || tx.state.status === 'submitted'}
      >
        Verify ARM Load
      </button>
      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="ARM loaded!" />
    </div>
  )
}
