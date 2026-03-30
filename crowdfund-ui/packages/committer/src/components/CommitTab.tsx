// ABOUTME: Commit flow UI — eligibility check, per-hop amount entry, review/confirm.
// ABOUTME: Handles USDC approval and sequential commit transactions per hop.

import { useState, useMemo, useCallback } from 'react'
import { Contract } from 'ethers'
import type { Signer } from 'ethers'
import {
  formatUsdc,
  parseUsdcInput,
  hopLabel,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  type HopStatsData,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'
import { useProRataEstimate } from '@/hooks/useProRataEstimate'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { ProRataEstimate } from './ProRataEstimate'
import { TransactionFlow } from './TransactionFlow'
import { getExplorerUrl } from '@/config/network'

export interface CommitTabProps {
  positions: HopPosition[]
  eligible: boolean
  balance: bigint
  needsApproval: (amount: bigint) => boolean
  refreshAllowance: () => Promise<void>
  signer: Signer | null
  crowdfundAddress: string
  usdcAddress: string
  hopStats: HopStatsData[]
  saleSize: bigint
  phase: number
  windowOpen: boolean
}

type Step = 'input' | 'review'

export function CommitTab(props: CommitTabProps) {
  const {
    positions,
    eligible,
    balance,
    needsApproval,
    refreshAllowance,
    signer,
    crowdfundAddress,
    usdcAddress,
    hopStats,
    saleSize,
    phase,
    windowOpen,
  } = props

  const [step, setStep] = useState<Step>('input')
  const [amounts, setAmounts] = useState<Map<number, string>>(new Map())
  const approvalTx = useTransactionFlow(signer)
  const commitTx = useTransactionFlow(signer)

  // Parse amounts to bigint
  const parsedAmounts = useMemo(() => {
    const m = new Map<number, bigint>()
    for (const [hop, input] of amounts) {
      const parsed = parseUsdcInput(input)
      if (parsed > 0n) m.set(hop, parsed)
    }
    return m
  }, [amounts])

  // Total commit amount
  const totalAmount = useMemo(() => {
    let sum = 0n
    for (const a of parsedAmounts.values()) sum += a
    return sum
  }, [parsedAmounts])

  // Pro-rata estimate
  const estimate = useProRataEstimate(parsedAmounts, hopStats, saleSize)

  // Validation
  const errors = useMemo(() => {
    const errs: string[] = []
    if (totalAmount > balance) errs.push('Insufficient USDC balance')
    for (const pos of positions) {
      const amt = parsedAmounts.get(pos.hop) ?? 0n
      if (amt > 0n && amt < CROWDFUND_CONSTANTS.MIN_COMMIT) {
        errs.push(`${hopLabel(pos.hop)}: minimum commitment is ${formatUsdc(CROWDFUND_CONSTANTS.MIN_COMMIT)}`)
      }
      if (amt > pos.remaining) {
        errs.push(`${hopLabel(pos.hop)}: exceeds remaining cap of ${formatUsdc(pos.remaining)}`)
      }
    }
    return errs
  }, [totalAmount, balance, positions, parsedAmounts])

  const handleAmountChange = useCallback((hop: number, value: string) => {
    setAmounts((prev) => {
      const next = new Map(prev)
      next.set(hop, value)
      return next
    })
  }, [])

  const handleMax = useCallback((hop: number, remaining: bigint) => {
    const maxForBalance = balance - (totalAmount - (parsedAmounts.get(hop) ?? 0n))
    const max = remaining < maxForBalance ? remaining : maxForBalance
    if (max > 0n) {
      handleAmountChange(hop, (Number(max) / 1e6).toString())
    }
  }, [balance, totalAmount, parsedAmounts, handleAmountChange])

  const handleApproveAndCommit = useCallback(async () => {
    if (!signer || totalAmount === 0n) return

    // Step 1: Approve if needed
    if (needsApproval(totalAmount)) {
      const success = await approvalTx.execute(async (s) => {
        const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, s)
        return usdc.approve(crowdfundAddress, totalAmount)
      })
      if (!success) return
      await refreshAllowance()
    }

    // Step 2: Commit per hop (sequential)
    for (const [hop, amount] of parsedAmounts) {
      const success = await commitTx.execute(async (s) => {
        const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
        return crowdfund.commit(hop, amount)
      })
      if (!success) return
    }

    // Reset form on success
    setAmounts(new Map())
    setStep('input')
  }, [
    signer, totalAmount, needsApproval, approvalTx, commitTx,
    usdcAddress, crowdfundAddress, parsedAmounts, refreshAllowance,
  ])

  if (!eligible) {
    return (
      <div className="p-4 text-center space-y-2">
        <div className="text-muted-foreground">Not Eligible</div>
        <div className="text-xs text-muted-foreground">
          Your address has not been invited to any hop level. You need an invite to participate.
        </div>
      </div>
    )
  }

  if (phase !== 0) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Commitment window is closed.
      </div>
    )
  }

  if (!windowOpen) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Commitment window is not yet open.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Balance display */}
      <div className="text-xs text-muted-foreground">
        USDC balance: <span className="text-foreground font-medium">{formatUsdc(balance)}</span>
      </div>

      {step === 'input' && (
        <>
          {/* Per-hop amount inputs */}
          {positions.map((pos) => (
            <div key={pos.hop} className="rounded border border-border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{hopLabel(pos.hop)}</span>
                <span className="text-xs text-muted-foreground">
                  Committed: {formatUsdc(pos.committed)} / {formatUsdc(pos.effectiveCap)}
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={amounts.get(pos.hop) ?? ''}
                  onChange={(e) => handleAmountChange(pos.hop, e.target.value)}
                  className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  className="px-3 py-2 text-xs rounded bg-muted text-muted-foreground hover:text-foreground"
                  onClick={() => handleMax(pos.hop, pos.remaining)}
                >
                  MAX
                </button>
              </div>
              {pos.remaining === 0n && (
                <div className="text-xs text-amber-500">Cap reached at this hop</div>
              )}
            </div>
          ))}

          {/* Pro-rata estimate */}
          {totalAmount > 0n && (
            <ProRataEstimate
              hopEstimates={estimate.hopEstimates}
              totalEstimatedArm={estimate.totalEstimatedArm}
              totalEstimatedRefund={estimate.totalEstimatedRefund}
            />
          )}

          {/* Errors */}
          {errors.length > 0 && (
            <div className="text-xs text-destructive space-y-1">
              {errors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          )}

          {/* Review button */}
          <button
            className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            disabled={totalAmount === 0n || errors.length > 0}
            onClick={() => setStep('review')}
          >
            Review Commitment
          </button>
        </>
      )}

      {step === 'review' && (
        <div className="space-y-4">
          <div className="rounded border border-border p-3 space-y-2">
            <div className="text-sm font-medium">Review Your Commitment</div>
            {[...parsedAmounts].map(([hop, amount]) => (
              <div key={hop} className="flex items-center justify-between text-sm">
                <span>{hopLabel(hop)}</span>
                <span className="font-medium">{formatUsdc(amount)}</span>
              </div>
            ))}
            <div className="border-t border-border pt-2 flex items-center justify-between text-sm">
              <span>Total</span>
              <span className="font-bold">{formatUsdc(totalAmount)}</span>
            </div>
          </div>

          {needsApproval(totalAmount) && (
            <div className="text-xs text-muted-foreground">
              Step 1: Approve USDC spending. Step 2: Commit{parsedAmounts.size > 1 ? ` (${parsedAmounts.size} transactions)` : ''}.
            </div>
          )}

          <ProRataEstimate
            hopEstimates={estimate.hopEstimates}
            totalEstimatedArm={estimate.totalEstimatedArm}
            totalEstimatedRefund={estimate.totalEstimatedRefund}
          />

          <div className="flex gap-2">
            <button
              className="flex-1 rounded border border-border px-4 py-2 text-sm hover:bg-muted"
              onClick={() => setStep('input')}
            >
              Back
            </button>
            <button
              className="flex-1 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              onClick={handleApproveAndCommit}
            >
              {needsApproval(totalAmount) ? 'Approve & Commit' : 'Commit'}
            </button>
          </div>

          <TransactionFlow
            state={approvalTx.state.status !== 'idle' ? approvalTx.state : commitTx.state}
            onReset={() => { approvalTx.reset(); commitTx.reset() }}
            successMessage="Commitment confirmed!"
            explorerUrl={getExplorerUrl()}
          />
        </div>
      )}
    </div>
  )
}
