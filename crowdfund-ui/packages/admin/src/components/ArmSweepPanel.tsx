// ABOUTME: ARM sweep panel for transferring unallocated ARM to treasury.
// ABOUTME: Shows sweepable amount, context-dependent explanation, and triggers withdrawUnallocatedArm().

import { Contract } from 'ethers'
import type { Signer } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS, formatArm } from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'

export interface ArmSweepPanelProps {
  signer: Signer | null
  crowdfundAddress: string
  contractArmBalance: bigint
  totalAllocatedArm: bigint
  totalArmTransferred: bigint
  phase: number
  refundMode: boolean
  claimDeadline: number
  blockTimestamp: number
}

function getSweepExplanation(phase: number, refundMode: boolean, claimDeadline: number, blockTimestamp: number): string {
  if (phase === 2) {
    return 'Canceled — all ARM is sweepable.'
  }
  if (phase === 1 && refundMode) {
    return 'Refund mode — sweeps all ARM (no allocations owed).'
  }
  if (phase === 1 && blockTimestamp >= claimDeadline) {
    return 'Claim deadline passed — all unclaimed ARM is sweepable.'
  }
  if (phase === 1) {
    return 'Sweeps ARM above pending participant claims.'
  }
  return ''
}

export function ArmSweepPanel(props: ArmSweepPanelProps) {
  const { signer, crowdfundAddress, contractArmBalance, totalAllocatedArm, totalArmTransferred, phase, refundMode, claimDeadline, blockTimestamp } = props
  const tx = useTransactionFlow(signer)

  // Sweepable = contract balance - (allocated - transferred)
  const pendingClaims = totalAllocatedArm > totalArmTransferred ? totalAllocatedArm - totalArmTransferred : 0n
  const sweepable = contractArmBalance > pendingClaims ? contractArmBalance - pendingClaims : 0n

  const explanation = getSweepExplanation(phase, refundMode, claimDeadline, blockTimestamp)

  const handleSweep = async () => {
    await tx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.withdrawUnallocatedArm()
    })
  }

  return (
    <div className="rounded border border-border p-3 space-y-2">
      <div className="text-sm font-medium">ARM Sweep</div>
      {explanation && (
        <div className="text-[10px] text-muted-foreground bg-muted/50 rounded px-2 py-1">
          {explanation}
        </div>
      )}
      <div className="text-xs space-y-1">
        <div>Contract ARM balance: {formatArm(contractArmBalance)}</div>
        <div>Pending claims: {formatArm(pendingClaims)}</div>
        <div>Sweepable: <span className="font-medium">{formatArm(sweepable)}</span></div>
      </div>
      <button
        className="w-full rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={sweepable === 0n || tx.state.status === 'pending' || tx.state.status === 'submitted'}
        onClick={handleSweep}
      >
        Sweep ARM to Treasury
      </button>
      <TransactionFlow state={tx.state} onReset={tx.reset} successMessage="ARM swept to treasury!" />
    </div>
  )
}
