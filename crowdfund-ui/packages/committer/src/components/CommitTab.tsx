// ABOUTME: Commit flow UI — eligibility check, per-hop amount entry, review/confirm.
// ABOUTME: Handles USDC approval and sequential commit transactions per hop.

import { useState, useMemo, useCallback } from 'react'
import { Contract, MaxUint256 } from 'ethers'
import type { Signer } from 'ethers'
import { ShieldOff } from 'lucide-react'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  AmountInput,
  Button,
  EmptyState,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
  InfoTooltip,
  TOOLTIPS,
  ToggleGroup,
  ToggleGroupItem,
  formatUsdc,
  parseUsdcInput,
  hopLabel,
  estimateAllocation,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  type HopStatsData,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'
import { useProRataEstimate } from '@/hooks/useProRataEstimate'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'
import { ProRataEstimate } from './ProRataEstimate'
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

interface CommitFormValues {
  approveUnlimited: boolean
  amounts: Record<string, string>
}

/** Build a zod schema for per-hop commit validation. Factory because balance + positions change over time. */
function makeCommitSchema(positions: HopPosition[], balance: bigint) {
  return z
    .object({
      approveUnlimited: z.boolean(),
      amounts: z.record(z.string(), z.string()),
    })
    .superRefine((data, ctx) => {
      let total = 0n
      for (const pos of positions) {
        const raw = data.amounts[String(pos.hop)] ?? ''
        if (!raw.trim()) continue
        const parsed = parseUsdcInput(raw)
        if (parsed === 0n) continue
        if (parsed < CROWDFUND_CONSTANTS.MIN_COMMIT) {
          ctx.addIssue({
            path: ['amounts', String(pos.hop)],
            code: 'custom',
            message: `Minimum ${formatUsdc(CROWDFUND_CONSTANTS.MIN_COMMIT)}`,
          })
        }
        if (parsed > pos.remaining) {
          ctx.addIssue({
            path: ['amounts', String(pos.hop)],
            code: 'custom',
            message: `Exceeds remaining cap of ${formatUsdc(pos.remaining)}`,
          })
        }
        total += parsed
      }
      if (total > balance) {
        ctx.addIssue({
          path: ['amounts'],
          code: 'custom',
          message: `Total ${formatUsdc(total)} exceeds your USDC balance of ${formatUsdc(balance)}`,
        })
      }
    })
}

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

  // Use estimateAllocation to get accurate per-hop allocation ceilings,
  // including the hop-2 floor reservation and hop-0→hop-1 rollover.
  // Handles saleSize === 0 (Active phase) internally.
  const cappedDemand = hopStats.reduce((sum, s) => sum + s.cappedCommitted, 0n)
  const { perHopAlloc } = estimateAllocation(hopStats, cappedDemand, saleSize)
  const hopAlloc = perHopAlloc[hop] ?? 0n

  if (hopAlloc === 0n && stats.cappedCommitted === 0n) return null

  if (hop <= 1) {
    const pct = hopAlloc > 0n ? Number((stats.cappedCommitted * 100n) / hopAlloc) : 0
    const warning = pct > 100
      ? `This hop is oversubscribed — pro-rata scaling applies`
      : null
    return { demand, pct, warning }
  }

  // Hop-2: show against floor allocation
  const pct = hopAlloc > 0n ? Number((stats.cappedCommitted * 100n) / hopAlloc) : 0
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
  const [commitSuccess, setCommitSuccess] = useState(false)
  const approvalTx = useTransactionFlow(signer, { explorerUrl: getExplorerUrl() })
  const commitTx = useTransactionFlow(signer, { explorerUrl: getExplorerUrl() })

  const schema = useMemo(() => makeCommitSchema(positions, balance), [positions, balance])

  const form = useForm<CommitFormValues>({
    // @hookform/resolvers v5 + zod v4: generic inference loses the schema binding;
    // runtime is correct but TS needs a cast.
    resolver: zodResolver(schema) as unknown as Resolver<CommitFormValues>,
    mode: 'onChange',
    defaultValues: { approveUnlimited: false, amounts: {} },
  })

  const amountsValues = form.watch('amounts')
  const approveUnlimited = form.watch('approveUnlimited')

  // Parse amounts to bigint
  const parsedAmounts = useMemo(() => {
    const m = new Map<number, bigint>()
    for (const pos of positions) {
      const raw = amountsValues?.[String(pos.hop)] ?? ''
      const parsed = parseUsdcInput(raw)
      if (parsed > 0n) m.set(pos.hop, parsed)
    }
    return m
  }, [amountsValues, positions])

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

  // Existing per-hop commitments (for returning committers)
  const existingCommitments = useMemo(() => {
    const m = new Map<number, bigint>()
    for (const pos of positions) {
      if (pos.committed > 0n) m.set(pos.hop, pos.committed)
    }
    return m
  }, [positions])

  // Pro-rata estimate (based on total position: existing + new)
  const estimate = useProRataEstimate(parsedAmounts, existingCommitments, hopStats, saleSize)

  // Surface the form-level "total exceeds balance" error (zod issue on path: ['amounts']).
  // RHF nests it under errors.amounts.root; fall back to errors.amounts.message.
  const amountsFieldErrors = form.formState.errors.amounts as
    | { root?: { message?: string }; message?: string }
    | undefined
  const totalError = amountsFieldErrors?.root?.message ?? amountsFieldErrors?.message ?? null

  const reviewDisabled =
    totalAmount === 0n ||
    !form.formState.isValid ||
    form.formState.isValidating

  const handleReview = useCallback(async () => {
    const ok = await form.trigger()
    if (ok && totalAmount > 0n) setStep('review')
  }, [form, totalAmount])

  const handleApproveAndCommit = useCallback(async () => {
    if (!signer || totalAmount === 0n) return

    // Step 1: Approve if needed
    if (needsApproval(totalAmount)) {
      const approveAmount = approveUnlimited ? MaxUint256 : totalAmount
      const label = approveUnlimited
        ? 'Approve USDC (unlimited)'
        : `Approve ${formatUsdc(totalAmount)} USDC`
      const success = await approvalTx.execute(label, async (s) => {
        const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, s)
        return usdc.approve(crowdfundAddress, approveAmount)
      })
      if (!success) return
      await refreshAllowance()
    }

    // Step 2: Commit per hop (sequential)
    for (const [hop, amount] of parsedAmounts) {
      const success = await commitTx.execute(
        `Commit ${formatUsdc(amount)} at ${hopLabel(hop)}`,
        async (s) => {
          const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
          return crowdfund.commit(hop, amount)
        },
      )
      if (!success) return
    }

    // Show post-commitment summary
    setCommitSuccess(true)
    form.reset({ approveUnlimited: false, amounts: {} })
    setStep('input')
  }, [
    signer, totalAmount, needsApproval, approveUnlimited, approvalTx, commitTx,
    usdcAddress, crowdfundAddress, parsedAmounts, refreshAllowance, form,
  ])

  if (!eligible) {
    return (
      <EmptyState
        icon={ShieldOff}
        title="Not Eligible"
        description="Your address has not been invited to any hop level. You need an invite to participate."
      />
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

  const submitBusy =
    approvalTx.state.status === 'pending' ||
    approvalTx.state.status === 'submitted' ||
    commitTx.state.status === 'pending' ||
    commitTx.state.status === 'submitted'

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleApproveAndCommit)} className="space-y-4">
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
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <span>Your positions:</span>
                <InfoTooltip text={TOOLTIPS.hop} label="What is a hop?" />
              </div>
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
              const currentHopAmount = parsedAmounts.get(pos.hop) ?? 0n
              const balanceHeadroom = balance - (totalAmount - currentHopAmount)
              const ceilings = [
                { label: 'Remaining at this hop', value: pos.remaining },
                { label: 'Wallet balance', value: balanceHeadroom < 0n ? 0n : balanceHeadroom },
              ]
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
                  <FormField
                    control={form.control}
                    name={`amounts.${pos.hop}`}
                    render={({ field, fieldState }) => (
                      <FormItem>
                        <FormControl>
                          <AmountInput
                            value={field.value ?? ''}
                            onChange={(v) => {
                              setCommitSuccess(false)
                              field.onChange(v)
                            }}
                            onBlur={field.onBlur}
                            ceilings={ceilings}
                            error={!!fieldState.error}
                            aria-label={`Commit amount for ${hopLabel(pos.hop)}`}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
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

            {/* Form-level balance-exceeded error (blocking) */}
            {totalError && (
              <div className="text-xs text-destructive">{totalError}</div>
            )}

            {/* Review button — blocked by any schema error (including balance) */}
            <Button
              type="button"
              className="w-full"
              disabled={reviewDisabled}
              onClick={handleReview}
            >
              Review Commitment
            </Button>
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
                <FormField
                  control={form.control}
                  name="approveUnlimited"
                  render={({ field }) => (
                    <ToggleGroup
                      type="single"
                      value={field.value ? 'unlimited' : 'exact'}
                      onValueChange={(v) => {
                        if (v === 'exact') field.onChange(false)
                        else if (v === 'unlimited') field.onChange(true)
                      }}
                      className="gap-2"
                    >
                      <ToggleGroupItem value="exact" size="sm" className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                        Approve exact amount
                      </ToggleGroupItem>
                      <ToggleGroupItem value="unlimited" size="sm" className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                        Approve unlimited
                      </ToggleGroupItem>
                    </ToggleGroup>
                  )}
                />
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
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setStep('input')}
                disabled={submitBusy}
              >
                Back
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={submitBusy}
              >
                {needsApproval(totalAmount) ? 'Approve & Commit' : 'Commit'}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Form>
  )
}
