// ABOUTME: Commit flow as a stepwise checkout — context → amount → review → status.
// ABOUTME: Pipeline (one row per tx) drives the final step's status display.

import { useState, useMemo, useCallback } from 'react'
import { Contract, MaxUint256 } from 'ethers'
import type { Signer, TransactionResponse } from 'ethers'
import { ShieldOff } from 'lucide-react'
import { useForm, useWatch, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  AmountInput,
  EmptyState,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
  InfoTooltip,
  StepFooter,
  Stepper,
  type StepperStep,
  TOOLTIPS,
  ToggleGroup,
  ToggleGroupItem,
  TxStatusPipeline,
  type TxPipelineRow,
  type TxPipelineStatus,
  formatUsdc,
  parseUsdcInput,
  hopLabel,
  estimateAllocation,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  useTxToast,
  type HopStatsData,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'
import { useProRataEstimate } from '@/hooks/useProRataEstimate'
import { ProRataEstimate } from './ProRataEstimate'
import { getExplorerUrl } from '@/config/network'
import { mapRevertToMessage } from '@/lib/revertMessages'

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
  /** Optional: invoked when the user clicks Back from step 1, returning to
   *  the Participate page's intent picker. */
  onBackToIntent?: () => void
}

type Step = 'context' | 'amount' | 'review' | 'status'

const STEPS: ReadonlyArray<StepperStep> = [
  { id: 'context', label: 'Confirm context' },
  { id: 'amount', label: 'Enter commit amount' },
  { id: 'review', label: 'Review and confirm' },
  { id: 'status', label: 'Pending / Success' },
]

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

  const pct = hopAlloc > 0n ? Number((stats.cappedCommitted * 100n) / hopAlloc) : 0
  const warning = pct < 100
    ? 'Floor not yet filled — full allocation likely'
    : null
  return { demand, pct, warning }
}

/** Update one row in the pipeline state by id. */
function updateRow(
  rows: TxPipelineRow[],
  id: string,
  patch: Partial<TxPipelineRow>,
): TxPipelineRow[] {
  return rows.map((r) => (r.id === id ? { ...r, ...patch } : r))
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
    onBackToIntent,
  } = props

  const [step, setStep] = useState<Step>('context')
  const [pipeline, setPipeline] = useState<TxPipelineRow[]>([])
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const [pipelineDone, setPipelineDone] = useState(false)
  const txToast = useTxToast({ explorerUrl: getExplorerUrl() })

  const schema = useMemo(() => makeCommitSchema(positions, balance), [positions, balance])

  const form = useForm<CommitFormValues>({
    resolver: zodResolver(schema) as unknown as Resolver<CommitFormValues>,
    mode: 'onChange',
    defaultValues: { approveUnlimited: false, amounts: {} },
  })

  const amountsValues = useWatch({ control: form.control, name: 'amounts' })
  const approveUnlimited = useWatch({ control: form.control, name: 'approveUnlimited' })

  const parsedAmounts = useMemo(() => {
    const m = new Map<number, bigint>()
    for (const pos of positions) {
      const raw = amountsValues?.[String(pos.hop)] ?? ''
      const parsed = parseUsdcInput(raw)
      if (parsed > 0n) m.set(pos.hop, parsed)
    }
    return m
  }, [amountsValues, positions])

  const totalAmount = useMemo(() => {
    let sum = 0n
    for (const a of parsedAmounts.values()) sum += a
    return sum
  }, [parsedAmounts])

  const activeHopCount = useMemo(() => {
    let count = 0
    for (const a of parsedAmounts.values()) {
      if (a > 0n) count++
    }
    return count
  }, [parsedAmounts])

  const existingCommitments = useMemo(() => {
    const m = new Map<number, bigint>()
    for (const pos of positions) {
      if (pos.committed > 0n) m.set(pos.hop, pos.committed)
    }
    return m
  }, [positions])

  const estimate = useProRataEstimate(parsedAmounts, existingCommitments, hopStats, saleSize)

  // Surface the form-level "total exceeds balance" error.
  const amountsFieldErrors = form.formState.errors.amounts as
    | { root?: { message?: string }; message?: string }
    | undefined
  const totalError = amountsFieldErrors?.root?.message ?? amountsFieldErrors?.message ?? null

  const amountStepDisabled =
    totalAmount === 0n ||
    !form.formState.isValid ||
    form.formState.isValidating

  const handleAmountContinue = useCallback(async () => {
    const ok = await form.trigger()
    if (ok && totalAmount > 0n) setStep('review')
  }, [form, totalAmount])

  /** Run the multi-tx pipeline (approval + per-hop commits) sequentially.
   *  Mirrors useTransactionFlow's behavior but tracks per-tx state in
   *  `pipeline` so the status step can render every step's outcome. */
  const runPipeline = useCallback(async () => {
    if (!signer || totalAmount === 0n) return

    setStep('status')
    setPipelineRunning(true)
    setPipelineError(null)
    setPipelineDone(false)

    interface PipelineOp {
      id: string
      label: string
      detail?: string
      send: (s: Signer) => Promise<TransactionResponse>
      onConfirmed?: () => Promise<void>
    }

    const ops: PipelineOp[] = []
    if (needsApproval(totalAmount)) {
      const approveAmount = approveUnlimited ? MaxUint256 : totalAmount
      const label = approveUnlimited
        ? 'Approve USDC (unlimited)'
        : `Approve ${formatUsdc(totalAmount)} USDC`
      ops.push({
        id: 'approve',
        label,
        detail: approveUnlimited ? 'unlimited' : formatUsdc(totalAmount),
        send: async (s) => {
          const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, s)
          return usdc.approve(crowdfundAddress, approveAmount)
        },
        onConfirmed: refreshAllowance,
      })
    }
    for (const [hop, amount] of parsedAmounts) {
      ops.push({
        id: `commit-${hop}`,
        label: `Commit at ${hopLabel(hop)}`,
        detail: formatUsdc(amount),
        send: async (s) => {
          const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
          return crowdfund.commit(hop, amount)
        },
      })
    }

    setPipeline(
      ops.map((o) => ({
        id: o.id,
        label: o.label,
        detail: o.detail,
        status: 'idle' as TxPipelineStatus,
        explorerUrl: explorerBuilder,
      })),
    )

    const setStatus = (id: string, patch: Partial<TxPipelineRow>) =>
      setPipeline((prev) => updateRow(prev, id, patch))

    for (const op of ops) {
      setStatus(op.id, { status: 'pending' })
      const handle = txToast.notifyTxPending(op.label)
      let txHash: string | null = null
      try {
        const tx = await op.send(signer)
        txHash = tx.hash
        setStatus(op.id, { status: 'submitted', txHash })
        txToast.notifyTxSubmitted(handle, tx.hash)

        const receipt = await tx.wait()
        if (!receipt || receipt.status === 0) {
          const msg = 'Transaction reverted'
          setStatus(op.id, { status: 'error', errorMessage: msg, txHash })
          txToast.notifyTxFailed(handle, msg)
          setPipelineError(msg)
          setPipelineRunning(false)
          return
        }

        setStatus(op.id, { status: 'confirmed', txHash })
        txToast.notifyTxConfirmed(handle)
        if (op.onConfirmed) await op.onConfirmed()
      } catch (err) {
        const msg = mapRevertToMessage(err)
        setStatus(op.id, { status: 'error', errorMessage: msg, txHash })
        txToast.notifyTxFailed(handle, msg)
        setPipelineError(msg)
        setPipelineRunning(false)
        return
      }
    }

    setPipelineRunning(false)
    setPipelineDone(true)
  }, [
    signer,
    totalAmount,
    needsApproval,
    approveUnlimited,
    parsedAmounts,
    usdcAddress,
    crowdfundAddress,
    refreshAllowance,
    txToast,
  ])

  const resetFlow = useCallback(() => {
    form.reset({ approveUnlimited: false, amounts: {} })
    setPipeline([])
    setPipelineError(null)
    setPipelineDone(false)
    setStep('context')
  }, [form])

  const explorer = getExplorerUrl()
  const explorerBuilder = useMemo(
    () => (explorer ? (h: string) => `${explorer}/tx/${h}` : undefined),
    [explorer],
  )

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

  const stepIndex = STEPS.findIndex((s) => s.id === step)

  return (
    <Stepper steps={STEPS} current={stepIndex}>
      <Form {...form}>
        {step === 'context' && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-base font-medium text-foreground">
                You're eligible to commit
              </div>
              <div className="text-sm text-muted-foreground">
                Confirm where you stand in the network before entering an amount.
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <span>Your positions</span>
                <InfoTooltip text={TOOLTIPS.hop} label="What is a hop?" />
              </div>
              {positions.map((pos) => (
                <div
                  key={pos.hop}
                  className="flex items-center justify-between rounded-md border border-border/60 bg-card/50 px-3 py-2 text-xs"
                >
                  <span>
                    <span className="font-medium text-foreground">{hopLabel(pos.hop)}</span>
                    {pos.invitesReceived > 1 && (
                      <span className="ml-1 text-muted-foreground">({pos.invitesReceived} slots)</span>
                    )}
                    <span className="ml-1 text-muted-foreground">— {inviterDisplay(pos, resolveENS)}</span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    Cap: {formatUsdc(pos.effectiveCap)} · Committed: {formatUsdc(pos.committed)}
                  </span>
                </div>
              ))}
            </div>
            <StepFooter
              onBack={onBackToIntent}
              onNext={() => setStep('amount')}
              backLabel="Back"
              nextLabel="Continue"
            />
          </div>
        )}

        {step === 'amount' && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-base font-medium text-foreground">
                Enter your commit amount
              </div>
              <div className="text-sm text-muted-foreground">
                You can commit at multiple hops if you have multiple positions.
              </div>
            </div>

            {positions.map((pos) => {
              const demand = hopDemandDisplay(pos.hop, hopStats, saleSize)
              const currentHopAmount = parsedAmounts.get(pos.hop) ?? 0n
              const balanceHeadroom = balance - (totalAmount - currentHopAmount)
              const ceilings = [
                { label: 'Remaining at this hop', value: pos.remaining },
                { label: 'Wallet balance', value: balanceHeadroom < 0n ? 0n : balanceHeadroom },
              ]
              return (
                <div key={pos.hop} className="rounded-md border border-border/60 bg-card/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{hopLabel(pos.hop)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      Committed: {formatUsdc(pos.committed)} / {formatUsdc(pos.effectiveCap)}
                    </span>
                  </div>
                  {demand && (
                    <div className="text-xs text-muted-foreground tabular-nums">
                      <span>
                        Hop demand: {demand.demand} ({demand.pct}% of{' '}
                        {pos.hop <= 1 ? 'ceiling' : 'floor'})
                      </span>
                      {demand.warning && (
                        <div className="mt-0.5 text-amber-500">{demand.warning}</div>
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
                            onChange={field.onChange}
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

            {totalAmount > 0n && (
              <ProRataEstimate
                hopEstimates={estimate.hopEstimates}
                totalEstimatedArm={estimate.totalEstimatedArm}
                totalEstimatedRefund={estimate.totalEstimatedRefund}
              />
            )}

            {totalAmount > 0n && (
              <div className="rounded-md border border-border/60 bg-card/40 p-3 space-y-1 text-sm">
                <div>
                  Total commitment:{' '}
                  <span className="font-medium tabular-nums">{formatUsdc(totalAmount)}</span>
                  {activeHopCount > 1 && (
                    <span className="text-muted-foreground"> across {activeHopCount} hops</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  Wallet balance: {formatUsdc(balance)}
                </div>
              </div>
            )}

            {totalError && <div className="text-xs text-destructive">{totalError}</div>}

            <StepFooter
              onBack={() => setStep('context')}
              onNext={handleAmountContinue}
              nextDisabled={amountStepDisabled}
              nextLabel="Continue"
            />
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-base font-medium text-foreground">
                Review and confirm
              </div>
              <div className="text-sm text-muted-foreground">
                You're committing {formatUsdc(totalAmount)} USDC
                {activeHopCount > 1 && <> across {activeHopCount} hops</>}.
              </div>
            </div>

            <div className="rounded-md border border-border/60 bg-card/40 p-3 space-y-2">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Breakdown
              </div>
              {[...parsedAmounts].map(([hop, amount]) => (
                <div key={hop} className="flex items-center justify-between text-sm">
                  <span>{hopLabel(hop)}</span>
                  <span className="font-medium tabular-nums">{formatUsdc(amount)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-border/60 pt-2 text-sm">
                <span>Total</span>
                <span className="font-bold tabular-nums">{formatUsdc(totalAmount)}</span>
              </div>
            </div>

            {needsApproval(totalAmount) && (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">
                  This will run {parsedAmounts.size + 1} transactions: 1 USDC approval +{' '}
                  {parsedAmounts.size} commit{parsedAmounts.size > 1 ? 's' : ''}.
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
                      <ToggleGroupItem
                        value="exact"
                        size="sm"
                        className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                      >
                        Approve exact amount
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value="unlimited"
                        size="sm"
                        className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                      >
                        Approve unlimited
                      </ToggleGroupItem>
                    </ToggleGroup>
                  )}
                />
                {approveUnlimited && (
                  <div className="text-[10px] text-amber-500">
                    Unlimited approval skips re-approval on future commits but grants the contract
                    full spending access.
                  </div>
                )}
              </div>
            )}

            <ProRataEstimate
              hopEstimates={estimate.hopEstimates}
              totalEstimatedArm={estimate.totalEstimatedArm}
              totalEstimatedRefund={estimate.totalEstimatedRefund}
            />

            <StepFooter
              onBack={() => setStep('amount')}
              onNext={runPipeline}
              nextLabel={needsApproval(totalAmount) ? 'Approve & Commit' : 'Confirm transaction'}
            />
          </div>
        )}

        {step === 'status' && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-base font-medium text-foreground">
                {pipelineRunning
                  ? 'Submitting your commitment'
                  : pipelineError
                  ? 'Something went wrong'
                  : pipelineDone
                  ? 'Transaction submitted!'
                  : 'Preparing transactions'}
              </div>
              <div className="text-sm text-muted-foreground">
                {pipelineRunning
                  ? 'Confirm each request in your wallet. This page will update as transactions confirm.'
                  : pipelineError
                  ? 'Some transactions did not complete. You can retry from the review step.'
                  : pipelineDone
                  ? 'Your commitment is now on-chain.'
                  : null}
              </div>
            </div>

            <TxStatusPipeline rows={pipeline} />

            <StepFooter
              onBack={pipelineRunning ? undefined : () => setStep('review')}
              onNext={pipelineDone ? resetFlow : undefined}
              backLabel="Back to review"
              nextLabel="New commitment"
              nextDisabled={!pipelineDone}
              nextVariant="outline"
              hideNext={!pipelineDone && !pipelineError}
            />
          </div>
        )}
      </Form>
    </Stepper>
  )
}
