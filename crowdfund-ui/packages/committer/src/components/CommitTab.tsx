// ABOUTME: Commit flow UI — eligibility check, per-hop amount entry, review/confirm.
// ABOUTME: Handles USDC approval and sequential commit transactions per hop.

import { useState, useMemo, useCallback } from 'react'
import { Contract, MaxUint256 } from 'ethers'
import type { Signer } from 'ethers'
import {
  formatUsdc,
  parseUsdcInput,
  hopLabel,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  HOP_CONFIGS,
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
  resolveENS: (addr: string) => string | null
}

type Step = 'input' | 'review'

/** Display inviter attribution for a position */
function inviterDisplay(pos: HopPosition, resolveENS: (addr: string) => string | null): string {
  if (pos.hop === 0) return 'invited by Armada'
  if (pos.invitedBy.length === 0) return ''

  const uniqueInviters = [...new Set(pos.invitedBy)]
  if (uniqueInviters.length === 1) {
    const display = resolveENS(uniqueInviters[0]) ?? `${uniqueInviters[0].slice(0, 6)}…${uniqueInviters[0].slice(-4)}`
    const suffix = pos.invitedBy.length > 1 ? ` ×${pos.invitedBy.length}` : ''
    return `invited by ${display}${suffix}`
  }

  const first = resolveENS(uniqueInviters[0]) ?? `${uniqueInviters[0].slice(0, 6)}…${uniqueInviters[0].slice(-4)}`
  return `invited by ${first} + ${uniqueInviters.length - 1} others`
}

/** Compute per-hop demand context display */
function hopDemandDisplay(
  hop: number,
  hopStats: HopStatsData[],
  saleSize: bigint,
): { demand: string; pct: number; warning: string | null } | null {
  if (hop >= hopStats.length) return null
  const stats = hopStats[hop]
  const demand = formatUsdc(stats.cappedCommitted)

  if (hop <= 1) {
    const ceilingBps = HOP_CONFIGS[hop].ceilingBps
    const ceiling = (saleSize * BigInt(ceilingBps)) / 10_000n
    if (ceiling === 0n) return null
    const pct = Number((stats.cappedCommitted * 100n) / ceiling)
    const warning = pct > 100
      ? `This hop is oversubscribed — pro-rata scaling applies`
      : null
    return { demand, pct, warning }
  }

  // Hop-2: floor-based
  const floor = (saleSize * BigInt(CROWDFUND_CONSTANTS.HOP2_FLOOR_BPS)) / 10_000n
  if (floor === 0n) return null
  const pct = Number((stats.cappedCommitted * 100n) / floor)
  const warning = pct < 100
    ? 'Floor not yet filled — full allocation likely'
    : null
  return { demand, pct, warning }
}

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
    resolveENS,
  } = props

  const [step, setStep] = useState<Step>('input')
  const [amounts, setAmounts] = useState<Map<number, string>>(new Map())
  const [approveUnlimited, setApproveUnlimited] = useState(false)
  const [commitSuccess, setCommitSuccess] = useState(false)
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

  // Active hop count
  const activeHopCount = useMemo(() => {
    let count = 0
    for (const a of parsedAmounts.values()) {
      if (a > 0n) count++
    }
    return count
  }, [parsedAmounts])

  // Pro-rata estimate
  const estimate = useProRataEstimate(parsedAmounts, hopStats, saleSize)

  // Balance check is a warning, not a blocking error
  const balanceInsufficient = totalAmount > 0n && totalAmount > balance

  // Validation errors (excludes balance — that's a non-blocking warning)
  const errors = useMemo(() => {
    const errs: string[] = []
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
  }, [positions, parsedAmounts])

  const handleAmountChange = useCallback((hop: number, value: string) => {
    setCommitSuccess(false)
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
      const approveAmount = approveUnlimited ? MaxUint256 : totalAmount
      const success = await approvalTx.execute(async (s) => {
        const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, s)
        return usdc.approve(crowdfundAddress, approveAmount)
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

    // Show post-commitment summary
    setCommitSuccess(true)
    setAmounts(new Map())
    setStep('input')
  }, [
    signer, totalAmount, needsApproval, approveUnlimited, approvalTx, commitTx,
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
      {/* Post-commitment summary */}
      {commitSuccess && (
        <div className="rounded border border-success/50 bg-success/10 p-3 text-sm">
          {positions.every((p) => p.remaining === 0n) ? (
            <>
              <div className="font-medium text-success">All positions filled.</div>
              <div className="text-xs text-muted-foreground mt-1">
                Total committed: {formatUsdc(positions.reduce((s, p) => s + p.committed, 0n))} across {positions.length} hops.
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-success">Committed successfully.</div>
              <div className="text-xs text-muted-foreground mt-1">
                You can add more to any hop with remaining capacity before the deadline.
              </div>
            </>
          )}
        </div>
      )}

      {step === 'input' && (
        <>
          {/* Eligibility display with inviter attribution */}
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Your positions:</div>
            {positions.map((pos) => (
              <div key={pos.hop} className="flex items-center justify-between text-xs">
                <span>
                  <span className="font-medium">{hopLabel(pos.hop)}</span>
                  {pos.invitesReceived > 1 && (
                    <span className="text-muted-foreground ml-1">({pos.invitesReceived} slots)</span>
                  )}
                  <span className="text-muted-foreground ml-1">— {inviterDisplay(pos, resolveENS)}</span>
                </span>
                <span className="text-muted-foreground">
                  Cap: {formatUsdc(pos.effectiveCap)} | Committed: {formatUsdc(pos.committed)}
                </span>
              </div>
            ))}
          </div>

          {/* Per-hop amount inputs */}
          {positions.map((pos) => {
            const demand = hopDemandDisplay(pos.hop, hopStats, saleSize)
            return (
              <div key={pos.hop} className="rounded border border-border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{hopLabel(pos.hop)}</span>
                  <span className="text-xs text-muted-foreground">
                    Committed: {formatUsdc(pos.committed)} / {formatUsdc(pos.effectiveCap)}
                  </span>
                </div>
                {/* Per-hop demand context */}
                {demand && (
                  <div className="text-xs text-muted-foreground">
                    <span>Current hop demand: {demand.demand} ({demand.pct}% of {pos.hop <= 1 ? 'ceiling' : 'floor'})</span>
                    {demand.warning && (
                      <div className="text-amber-500 mt-0.5">{demand.warning}</div>
                    )}
                  </div>
                )}
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
            )
          })}

          {/* Pro-rata estimate */}
          {totalAmount > 0n && (
            <ProRataEstimate
              hopEstimates={estimate.hopEstimates}
              totalEstimatedArm={estimate.totalEstimatedArm}
              totalEstimatedRefund={estimate.totalEstimatedRefund}
            />
          )}

          {/* Multi-hop total summary */}
          {totalAmount > 0n && (
            <div className="rounded border border-border p-3 space-y-1 text-sm">
              <div>
                Total commitment: <span className="font-medium">{formatUsdc(totalAmount)}</span>
                {activeHopCount > 1 && <span className="text-muted-foreground"> across {activeHopCount} hops</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                Your USDC balance: {formatUsdc(balance)}
              </div>
            </div>
          )}

          {/* Balance warning (non-blocking) */}
          {balanceInsufficient && (
            <div className="text-xs text-amber-500">
              Total exceeds your USDC balance. The transaction will revert if balance is insufficient.
            </div>
          )}

          {/* Validation errors */}
          {errors.length > 0 && (
            <div className="text-xs text-destructive space-y-1">
              {errors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          )}

          {/* Review button — balance does NOT block submission */}
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

          {/* Approve exact vs unlimited option */}
          {needsApproval(totalAmount) && (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">
                Step 1: Approve USDC spending. Step 2: Commit{parsedAmounts.size > 1 ? ` (${parsedAmounts.size} transactions)` : ''}.
              </div>
              <div className="flex gap-2">
                <button
                  className={`px-3 py-1 rounded text-xs ${
                    !approveUnlimited ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setApproveUnlimited(false)}
                >
                  Approve exact amount
                </button>
                <button
                  className={`px-3 py-1 rounded text-xs ${
                    approveUnlimited ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setApproveUnlimited(true)}
                >
                  Approve unlimited
                </button>
              </div>
              {approveUnlimited && (
                <div className="text-[10px] text-amber-500">
                  Unlimited approval allows future commits without re-approving, but grants the contract full spending access.
                </div>
              )}
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
