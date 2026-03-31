// ABOUTME: Claim tab for ARM token claims and USDC refunds after finalization.
// ABOUTME: State-dependent rendering: pre-fin countdown, post-fin claims, refund mode, cancel.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer, JsonRpcProvider } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  formatUsdc,
  formatArm,
  formatCountdown,
  hopLabel,
  type CrowdfundGraph,
} from '@armada/crowdfund-shared'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { TransactionFlow } from './TransactionFlow'
import { DelegateInput } from './DelegateInput'
import { getExplorerUrl } from '@/config/network'

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
  windowEnd: number
  cappedDemand: bigint
  graph: CrowdfundGraph
}

/** Per-hop allocation row for the settlement table */
interface HopAllocation {
  hop: number
  committed: bigint
  armAllocated: bigint
  acceptedUsdc: bigint
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
    windowEnd,
    cappedDemand,
    graph,
  } = props

  const [delegate, setDelegate] = useState(address)
  const [armAmount, setArmAmount] = useState<bigint>(0n)
  const [refundAmount, setRefundAmount] = useState<bigint>(0n)
  const [hasClaimed, setHasClaimed] = useState(false)
  const [hasRefundClaimed, setHasRefundClaimed] = useState(false)
  const [loading, setLoading] = useState(true)

  const claimArmTx = useTransactionFlow(signer)
  const claimRefundTx = useTransactionFlow(signer)

  // Derive per-hop allocation from graph nodes
  const hopAllocations = useMemo((): HopAllocation[] => {
    const allocations: HopAllocation[] = []
    for (let hop = 0; hop < 3; hop++) {
      const node = graph.nodes.get(`${address.toLowerCase()}-${hop}`)
      if (!node || node.invitesReceived === 0) continue
      allocations.push({
        hop,
        committed: node.committed,
        armAllocated: node.allocatedArm ?? 0n,
        acceptedUsdc: node.acceptedUsdc ?? 0n,
      })
    }
    return allocations
  }, [graph.nodes, address])

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
        // Check refund claimed status from graph summary
        const summary = graph.summaries.get(address.toLowerCase())
        if (summary) {
          setHasRefundClaimed(summary.refundClaimed)
        }
      } catch {
        // Non-fatal
      }
      setLoading(false)
    }

    fetchAllocation()
  }, [provider, crowdfundAddress, address, phase, graph.summaries])

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
    const windowTimeLeft = windowEnd > 0 && blockTimestamp > 0
      ? windowEnd - blockTimestamp
      : 0

    // P1.5: Check if window has ended and capped demand is below minimum
    const windowEnded = windowEnd > 0 && blockTimestamp > windowEnd
    const belowMinimum = cappedDemand < CROWDFUND_CONSTANTS.MIN_SALE

    if (windowEnded && belowMinimum) {
      return (
        <div className="p-4 text-center space-y-2">
          <div className="text-amber-500 font-medium">Commitment Window Ended</div>
          <div className="text-xs text-muted-foreground">
            Net proceeds are below the {formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)} minimum.
            Refund will be available after finalization.
          </div>
          {totalCommitted > 0n && (
            <div className="text-xs text-muted-foreground">
              Your committed: {formatUsdc(totalCommitted)}
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="p-4 text-center space-y-2">
        <div className="text-muted-foreground">Claims Available After Finalization</div>
        <div className="text-xs text-muted-foreground">
          The commitment window must end and the sale must be finalized before claims are available.
        </div>
        {windowTimeLeft > 0 && (
          <div className="text-xs text-muted-foreground">
            Commitment deadline in {formatCountdown(windowTimeLeft)}
          </div>
        )}
        {totalCommitted > 0n && (
          <div className="text-xs text-muted-foreground">
            Your committed: {formatUsdc(totalCommitted)}
          </div>
        )}
      </div>
    )
  }

  if (loading) {
    return <div className="p-4 text-center text-muted-foreground">Loading allocation...</div>
  }

  // P1.2: Already claimed — show amounts
  if (hasClaimed && hasRefundClaimed) {
    return (
      <div className="p-4 text-center space-y-2">
        <div className="text-success font-medium">All Claims Complete</div>
        {armAmount > 0n && (
          <div className="text-xs text-muted-foreground">
            ARM: {formatArm(armAmount)} claimed
          </div>
        )}
        {refundAmount > 0n && (
          <div className="text-xs text-muted-foreground">
            USDC: {formatUsdc(refundAmount)} refund claimed
          </div>
        )}
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
        <TransactionFlow state={claimRefundTx.state} onReset={claimRefundTx.reset} successMessage="Refund claimed!" explorerUrl={getExplorerUrl()} />
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
        <TransactionFlow state={claimRefundTx.state} onReset={claimRefundTx.reset} successMessage="Refund claimed!" explorerUrl={getExplorerUrl()} />
      </div>
    )
  }

  // Post-finalization (success) — ARM claim + refund
  const claimTimeLeft = claimDeadline - blockTimestamp

  return (
    <div className="space-y-4">
      {/* P1.3: Claim deadline with expiry distinction */}
      <div className="text-xs text-muted-foreground">
        Claim deadline: {claimTimeLeft > 0 ? formatCountdown(claimTimeLeft) : 'expired'}
      </div>
      <div className="text-xs text-muted-foreground italic">
        ARM claim expires at this deadline. USDC refund does not expire.
      </div>

      {/* P1.1: Per-hop allocation breakdown */}
      {hopAllocations.length > 0 && (
        <div className="rounded border border-border p-3 space-y-2 text-xs">
          <div className="text-muted-foreground font-medium text-sm">Settlement Breakdown</div>
          {hopAllocations.map((alloc) => {
            const pct = alloc.committed > 0n
              ? Math.round(Number(alloc.acceptedUsdc * 100n) / Number(alloc.committed))
              : 0
            return (
              <div key={alloc.hop} className="flex justify-between items-center">
                <span className="text-muted-foreground">{hopLabel(alloc.hop)}</span>
                <span>
                  {formatUsdc(alloc.committed)} committed
                  {alloc.acceptedUsdc > 0n && (
                    <span className="text-success ml-1">
                      → {formatArm(alloc.armAllocated)} ({pct}%)
                    </span>
                  )}
                </span>
              </div>
            )
          })}
          <div className="border-t border-border pt-2 flex justify-between items-center text-sm font-medium">
            <span>Total</span>
            <span>
              {formatUsdc(totalCommitted)} → {formatArm(armAmount)} + {formatUsdc(refundAmount)} refund
            </span>
          </div>
        </div>
      )}

      {/* Allocation summary (fallback when no per-hop data) */}
      {hopAllocations.length === 0 && (
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
      )}

      {/* ARM claim with delegation */}
      {armAmount > 0n && !hasClaimed && (
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
          <TransactionFlow state={claimArmTx.state} onReset={claimArmTx.reset} successMessage="ARM claimed!" explorerUrl={getExplorerUrl()} />
        </div>
      )}

      {/* P1.2: Show claimed status for ARM if already claimed but refund not yet */}
      {hasClaimed && armAmount > 0n && (
        <div className="text-xs text-success">ARM: {formatArm(armAmount)} claimed</div>
      )}

      {/* USDC refund */}
      {refundAmount > 0n && !hasRefundClaimed && (
        <div className="space-y-3 border-t border-border pt-3">
          <button
            className="w-full rounded border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
            disabled={claimRefundTx.state.status === 'pending' || claimRefundTx.state.status === 'submitted'}
            onClick={handleClaimRefund}
          >
            Claim USDC Refund ({formatUsdc(refundAmount)})
          </button>
          <TransactionFlow state={claimRefundTx.state} onReset={claimRefundTx.reset} successMessage="Refund claimed!" explorerUrl={getExplorerUrl()} />
        </div>
      )}

      {/* P1.2: Show refund claimed status */}
      {hasRefundClaimed && refundAmount > 0n && (
        <div className="text-xs text-success">USDC: {formatUsdc(refundAmount)} refund claimed</div>
      )}

      {armAmount === 0n && refundAmount === 0n && (
        <div className="text-xs text-muted-foreground text-center">No allocation found for this address.</div>
      )}
    </div>
  )
}
