// ABOUTME: Claim tab for ARM token claims and USDC refunds after finalization.
// ABOUTME: State-dependent rendering: pre-fin countdown, post-fin claims, refund mode, cancel.

import { useState, useEffect, useCallback } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer, JsonRpcProvider } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  formatUsdc,
  formatArm,
  formatCountdown,
} from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'
import { DelegateInput } from './DelegateInput'

export interface ClaimTabProps {
  address: string
  signer: Signer | null
  provider: JsonRpcProvider | null
  crowdfundAddress: string
  phase: number
  refundMode: boolean
  blockTimestamp: number
  claimDeadline: number
  totalCommitted: bigint
}

export function ClaimTab(props: ClaimTabProps) {
  const {
    address,
    signer,
    provider,
    crowdfundAddress,
    phase,
    refundMode,
    blockTimestamp,
    claimDeadline,
    totalCommitted,
  } = props

  const [delegate, setDelegate] = useState(address)
  const [armAmount, setArmAmount] = useState<bigint>(0n)
  const [refundAmount, setRefundAmount] = useState<bigint>(0n)
  const [hasClaimed, setHasClaimed] = useState(false)
  const [loading, setLoading] = useState(true)

  const claimArmTx = useTransactionFlow(signer)
  const claimRefundTx = useTransactionFlow(signer)

  // Fetch allocation and claim status
  useEffect(() => {
    if (!provider || !crowdfundAddress || !address || phase < 1) {
      setLoading(false)
      return
    }

    const fetchAllocation = async () => {
      try {
        const contract = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, provider)
        const [allocation, claimed] = await Promise.all([
          contract.computeAllocation(address) as Promise<[bigint, bigint]>,
          contract.claimed(address) as Promise<boolean>,
        ])
        setArmAmount(allocation[0])
        setRefundAmount(allocation[1])
        setHasClaimed(claimed)
      } catch {
        // Non-fatal
      }
      setLoading(false)
    }

    fetchAllocation()
  }, [provider, crowdfundAddress, address, phase])

  const handleClaimArm = useCallback(async () => {
    if (!isAddress(delegate)) return
    await claimArmTx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.claim(delegate)
    })
  }, [delegate, crowdfundAddress, claimArmTx])

  const handleClaimRefund = useCallback(async () => {
    await claimRefundTx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.claimRefund()
    })
  }, [crowdfundAddress, claimRefundTx])

  // Pre-finalization
  if (phase === 0) {
    return (
      <div className="p-4 text-center space-y-2">
        <div className="text-muted-foreground">Claims Available After Finalization</div>
        <div className="text-xs text-muted-foreground">
          The commitment window must end and the sale must be finalized before claims are available.
        </div>
      </div>
    )
  }

  if (loading) {
    return <div className="p-4 text-center text-muted-foreground">Loading allocation...</div>
  }

  // Already claimed
  if (hasClaimed) {
    return (
      <div className="p-4 text-center space-y-2">
        <div className="text-success font-medium">Already Claimed</div>
        <div className="text-xs text-muted-foreground">
          You have already claimed your ARM tokens and refund.
        </div>
      </div>
    )
  }

  // Canceled — full refund
  if (phase === 2) {
    return (
      <div className="space-y-4">
        <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          Crowdfund was canceled. Claim your full refund below.
        </div>
        <div className="text-sm">
          Refund: <span className="font-medium">{formatUsdc(totalCommitted)}</span>
        </div>
        <button
          className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={claimRefundTx.state.status === 'pending' || claimRefundTx.state.status === 'submitted'}
          onClick={handleClaimRefund}
        >
          Claim Refund
        </button>
        <TransactionFlow state={claimRefundTx.state} onReset={claimRefundTx.reset} successMessage="Refund claimed!" />
      </div>
    )
  }

  // Post-finalization (refund mode)
  if (refundMode) {
    return (
      <div className="space-y-4">
        <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-500">
          Sale did not meet minimum. Claim your full refund below.
        </div>
        <div className="text-sm">
          Refund: <span className="font-medium">{formatUsdc(totalCommitted)}</span>
        </div>
        <button
          className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={claimRefundTx.state.status === 'pending' || claimRefundTx.state.status === 'submitted'}
          onClick={handleClaimRefund}
        >
          Claim Refund
        </button>
        <TransactionFlow state={claimRefundTx.state} onReset={claimRefundTx.reset} successMessage="Refund claimed!" />
      </div>
    )
  }

  // Post-finalization (success) — ARM claim + refund
  const claimTimeLeft = claimDeadline - blockTimestamp

  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground">
        Claim deadline: {claimTimeLeft > 0 ? formatCountdown(claimTimeLeft) : 'expired'}
      </div>

      {/* Allocation summary */}
      <div className="rounded border border-border p-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">ARM Allocation</span>
          <span className="font-medium">{formatArm(armAmount)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">USDC Refund</span>
          <span className="font-medium">{formatUsdc(refundAmount)}</span>
        </div>
      </div>

      {/* ARM claim with delegation */}
      {armAmount > 0n && (
        <div className="space-y-3">
          <DelegateInput
            connectedAddress={address}
            value={delegate}
            onChange={setDelegate}
          />
          <button
            className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            disabled={!isAddress(delegate) || claimArmTx.state.status === 'pending' || claimArmTx.state.status === 'submitted'}
            onClick={handleClaimArm}
          >
            Claim ARM
          </button>
          <TransactionFlow state={claimArmTx.state} onReset={claimArmTx.reset} successMessage="ARM claimed!" />
        </div>
      )}

      {/* USDC refund */}
      {refundAmount > 0n && (
        <div className="space-y-3 border-t border-border pt-3">
          <button
            className="w-full rounded border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
            disabled={claimRefundTx.state.status === 'pending' || claimRefundTx.state.status === 'submitted'}
            onClick={handleClaimRefund}
          >
            Claim USDC Refund ({formatUsdc(refundAmount)})
          </button>
          <TransactionFlow state={claimRefundTx.state} onReset={claimRefundTx.reset} successMessage="Refund claimed!" />
        </div>
      )}

      {armAmount === 0n && refundAmount === 0n && (
        <div className="text-xs text-muted-foreground text-center">No allocation found for this address.</div>
      )}
    </div>
  )
}
