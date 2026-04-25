// ABOUTME: Claim flow as a stepwise checkout when there's something to claim.
// ABOUTME: Pre-claim and terminal states render as info cards instead of the stepper.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Contract, isAddress } from 'ethers'
import type { Signer, JsonRpcProvider, TransactionResponse } from 'ethers'
import { Inbox } from 'lucide-react'
import {
  EmptyState,
  ErrorAlert,
  InfoTooltip,
  StepFooter,
  Stepper,
  type StepperStep,
  TOOLTIPS,
  TxStatusPipeline,
  type TxPipelineRow,
  type TxPipelineStatus,
  CROWDFUND_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  formatUsdc,
  formatArm,
  formatCountdown,
  hopLabel,
  useTxToast,
  type CrowdfundGraph,
} from '@armada/crowdfund-shared'
import { DelegateInput } from './DelegateInput'
import { getExplorerUrl } from '@/config/network'
import { mapRevertToMessage } from '@/lib/revertMessages'

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

interface HopAllocation {
  hop: number
  committed: bigint
  armAllocated: bigint
  acceptedUsdc: bigint
}

type ClaimMode = 'arm' | 'refund'
type Step = 'review' | 'delegate' | 'confirm' | 'status'

const ARM_STEPS: ReadonlyArray<StepperStep> = [
  { id: 'review', label: 'Review allocation' },
  { id: 'delegate', label: 'Set delegate' },
  { id: 'confirm', label: 'Confirm' },
  { id: 'status', label: 'Pending / Success' },
]

const REFUND_STEPS: ReadonlyArray<StepperStep> = [
  { id: 'review', label: 'Review refund' },
  { id: 'confirm', label: 'Confirm' },
  { id: 'status', label: 'Pending / Success' },
]

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

  const [step, setStep] = useState<Step>('review')
  const [pipeline, setPipeline] = useState<TxPipelineRow[]>([])
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const [pipelineDone, setPipelineDone] = useState(false)
  const txToast = useTxToast({ explorerUrl: getExplorerUrl() })

  // Per-hop allocation rows derived from the graph
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
        const summary = graph.summaries.get(address.toLowerCase())
        if (summary) setHasRefundClaimed(summary.refundClaimed)
      } catch {
        // Non-fatal
      }
      setLoading(false)
    }
    fetchAllocation()
  }, [provider, crowdfundAddress, address, phase, graph.summaries])

  const explorer = getExplorerUrl()
  const explorerBuilder = useMemo(
    () => (explorer ? (h: string) => `${explorer}/tx/${h}` : undefined),
    [explorer],
  )

  /** Run the claim pipeline. The mode (arm vs refund) decides which contract
   *  call fires. Toast notifications mirror state transitions. */
  const runClaim = useCallback(
    async (mode: ClaimMode) => {
      if (!signer) return

      setStep('status')
      setPipelineRunning(true)
      setPipelineError(null)
      setPipelineDone(false)

      const opLabel = mode === 'arm' ? 'Claim ARM' : 'Claim USDC refund'
      const opDetail =
        mode === 'arm'
          ? formatArm(armAmount) +
            (refundAmount > 0n ? ` + ${formatUsdc(refundAmount)} refund` : '')
          : formatUsdc(refundMode || phase === 2 ? totalCommitted : refundAmount)

      setPipeline([
        {
          id: mode,
          label: opLabel,
          detail: opDetail,
          status: 'idle' as TxPipelineStatus,
          explorerUrl: explorerBuilder,
        },
      ])

      const setRow = (patch: Partial<TxPipelineRow>) =>
        setPipeline((prev) => prev.map((r) => (r.id === mode ? { ...r, ...patch } : r)))

      setRow({ status: 'pending' })
      const handle = txToast.notifyTxPending(opLabel)
      let txHash: string | null = null
      try {
        const send = async (s: Signer): Promise<TransactionResponse> => {
          const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
          if (mode === 'arm') return crowdfund.claim(delegate)
          return crowdfund.claimRefund()
        }
        const tx = await send(signer)
        txHash = tx.hash
        setRow({ status: 'submitted', txHash })
        txToast.notifyTxSubmitted(handle, tx.hash)

        const receipt = await tx.wait()
        if (!receipt || receipt.status === 0) {
          const msg = 'Transaction reverted'
          setRow({ status: 'error', errorMessage: msg, txHash })
          txToast.notifyTxFailed(handle, msg)
          setPipelineError(msg)
          setPipelineRunning(false)
          return
        }

        setRow({ status: 'confirmed', txHash })
        txToast.notifyTxConfirmed(handle)
        if (mode === 'arm') setHasClaimed(true)
        else setHasRefundClaimed(true)
        setPipelineRunning(false)
        setPipelineDone(true)
      } catch (err) {
        const msg = mapRevertToMessage(err)
        setRow({ status: 'error', errorMessage: msg, txHash })
        txToast.notifyTxFailed(handle, msg)
        setPipelineError(msg)
        setPipelineRunning(false)
      }
    },
    [
      signer,
      delegate,
      armAmount,
      refundAmount,
      refundMode,
      phase,
      totalCommitted,
      crowdfundAddress,
      txToast,
      explorerBuilder,
    ],
  )

  // ── Pre-claim / terminal info states (no stepper) ──────────────────────

  if (phase === 0) {
    const windowTimeLeft =
      windowEnd > 0 && blockTimestamp > 0 ? windowEnd - blockTimestamp : 0
    const windowEnded = windowEnd > 0 && blockTimestamp > windowEnd
    const belowMinimum = cappedDemand < CROWDFUND_CONSTANTS.MIN_SALE

    if (windowEnded && belowMinimum) {
      return (
        <div className="space-y-4 p-4">
          <ErrorAlert variant="warning" title="Below minimum raise">
            The commitment deadline has passed and capped demand (
            {formatUsdc(cappedDemand)}) is below the minimum raise (
            {formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)}). The sale must be finalized
            before refunds are available — anyone can call finalize().
          </ErrorAlert>
          {totalCommitted > 0n && (
            <div className="text-sm">
              Your deposit:{' '}
              <span className="font-medium tabular-nums">{formatUsdc(totalCommitted)}</span>
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="space-y-2 p-4 text-center">
        <div className="text-muted-foreground">Claims open after finalization</div>
        <div className="text-xs text-muted-foreground">
          The commitment window must end and the sale must be finalized first.
        </div>
        {windowTimeLeft > 0 && (
          <div className="text-xs text-muted-foreground tabular-nums">
            Commitment deadline in {formatCountdown(windowTimeLeft)}
          </div>
        )}
        {totalCommitted > 0n && (
          <div className="text-xs text-muted-foreground tabular-nums">
            Your committed: {formatUsdc(totalCommitted)}
          </div>
        )}
      </div>
    )
  }

  if (loading) {
    return <div className="p-4 text-center text-muted-foreground">Loading allocation…</div>
  }

  if (hasClaimed && hasRefundClaimed) {
    return (
      <div className="space-y-2 p-4 text-center">
        <div className="font-medium text-success">All claims complete</div>
        {armAmount > 0n && (
          <div className="text-xs text-muted-foreground tabular-nums">
            ARM: {formatArm(armAmount)} claimed
          </div>
        )}
        {refundAmount > 0n && (
          <div className="text-xs text-muted-foreground tabular-nums">
            USDC: {formatUsdc(refundAmount)} refund claimed
          </div>
        )}
      </div>
    )
  }

  const armClaimExpired = claimDeadline > 0 && blockTimestamp > claimDeadline
  const claimTimeLeft = claimDeadline - blockTimestamp

  // Determine whether the user is in a refund-only path or an ARM-claim path.
  // Refund-only: phase 2 (canceled), refundMode, or ARM-claim window expired.
  const isRefundPath =
    phase === 2 ||
    refundMode ||
    (armClaimExpired && refundAmount === 0n && armAmount > 0n) ||
    (armAmount === 0n && refundAmount > 0n)

  // Nothing to claim
  if (
    armAmount === 0n &&
    refundAmount === 0n &&
    !refundMode &&
    phase !== 2
  ) {
    return (
      <EmptyState
        icon={Inbox}
        title="No allocation found"
        description="This address did not commit during the window. There is nothing to claim."
      />
    )
  }

  // ── Stepper paths ──────────────────────────────────────────────────────

  const refundPathAmount = phase === 2 ? totalCommitted : refundMode ? totalCommitted : refundAmount
  const mode: ClaimMode = isRefundPath ? 'refund' : 'arm'
  const steps = mode === 'arm' ? ARM_STEPS : REFUND_STEPS
  const stepIndex = Math.max(
    0,
    steps.findIndex((s) => s.id === step),
  )

  const resetFlow = () => {
    setPipeline([])
    setPipelineError(null)
    setPipelineDone(false)
    setStep('review')
  }

  return (
    <Stepper steps={steps} current={stepIndex}>
      {step === 'review' && (
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-base font-medium text-foreground">
              {mode === 'arm' ? 'Review your allocation' : 'Review your refund'}
            </div>
            <div className="text-sm text-muted-foreground">
              {phase === 2
                ? 'The crowdfund was cancelled. You can claim a full refund of your commitment.'
                : refundMode
                ? 'Total allocation after hop ceilings did not meet the minimum raise. You can claim a full refund.'
                : armClaimExpired
                ? 'The 3-year ARM claim deadline has passed. Any unclaimed ARM is forfeited; you can still claim your USDC refund.'
                : 'Review your settlement before claiming.'}
            </div>
          </div>

          {!armClaimExpired && mode === 'arm' && claimTimeLeft > 0 && (
            <div className="rounded-md border border-border/60 bg-card/40 p-3 text-xs text-muted-foreground tabular-nums">
              Claim deadline in {formatCountdown(claimTimeLeft)}. ARM claim expires at this
              deadline; the USDC refund (if any) does not.
            </div>
          )}
          {armClaimExpired && mode === 'arm' && (
            <ErrorAlert variant="warning">
              The 3-year ARM claim deadline has passed. Any unclaimed ARM has been forfeited.
            </ErrorAlert>
          )}

          {mode === 'arm' && hopAllocations.length > 0 && (
            <div className="rounded-md border border-border/60 bg-card/40 p-3 space-y-2 text-xs">
              <div className="flex items-center gap-1 text-sm font-medium text-foreground">
                <span>Settlement breakdown</span>
                <InfoTooltip text={TOOLTIPS.allocation} label="What is allocation?" />
              </div>
              {hopAllocations.map((alloc) => {
                const pct =
                  alloc.committed > 0n
                    ? Math.round(Number(alloc.acceptedUsdc * 100n) / Number(alloc.committed))
                    : 0
                return (
                  <div key={alloc.hop} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{hopLabel(alloc.hop)}</span>
                    <span className="tabular-nums">
                      {formatUsdc(alloc.committed)} committed
                      {alloc.acceptedUsdc > 0n && (
                        <span className="ml-1 text-success">
                          → {formatArm(alloc.armAllocated)} ({pct}%)
                        </span>
                      )}
                    </span>
                  </div>
                )
              })}
              <div className="flex items-center justify-between border-t border-border/60 pt-2 text-sm font-medium tabular-nums">
                <span>Total</span>
                <span>
                  {formatUsdc(totalCommitted)} → {formatArm(armAmount)}
                  {refundAmount > 0n && <> + {formatUsdc(refundAmount)} refund</>}
                </span>
              </div>
            </div>
          )}

          {mode === 'arm' && hopAllocations.length === 0 && (
            <div className="rounded-md border border-border/60 bg-card/40 p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">ARM allocation</span>
                <span className="font-medium tabular-nums">{formatArm(armAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">USDC refund</span>
                <span className="font-medium tabular-nums">{formatUsdc(refundAmount)}</span>
              </div>
            </div>
          )}

          {mode === 'refund' && (
            <div className="rounded-md border border-border/60 bg-card/40 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Refund</span>
                <span className="font-medium tabular-nums">
                  {formatUsdc(refundPathAmount)}
                </span>
              </div>
            </div>
          )}

          <StepFooter
            onNext={() => setStep(mode === 'arm' ? 'delegate' : 'confirm')}
            nextLabel="Continue"
          />
        </div>
      )}

      {step === 'delegate' && mode === 'arm' && (
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-base font-medium text-foreground">Set your delegate</div>
            <div className="text-sm text-muted-foreground">
              Delegation is required for governance voting. You can delegate to yourself and
              change the delegate at any time after claiming.
            </div>
          </div>

          <DelegateInput
            connectedAddress={address}
            value={delegate}
            onChange={setDelegate}
          />

          <StepFooter
            onBack={() => setStep('review')}
            onNext={() => setStep('confirm')}
            nextDisabled={!isAddress(delegate)}
            nextLabel="Continue"
          />
        </div>
      )}

      {step === 'confirm' && (
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-base font-medium text-foreground">Confirm claim</div>
            <div className="text-sm text-muted-foreground">
              {mode === 'arm'
                ? `Claim ${formatArm(armAmount)}${refundAmount > 0n ? ` plus ${formatUsdc(refundAmount)} refund` : ''}.`
                : `Claim ${formatUsdc(refundPathAmount)} refund.`}
            </div>
          </div>

          <div className="rounded-md border border-border/60 bg-card/40 p-3 space-y-2 text-sm">
            {mode === 'arm' ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">ARM</span>
                  <span className="font-medium tabular-nums">{formatArm(armAmount)}</span>
                </div>
                {refundAmount > 0n && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">USDC refund</span>
                    <span className="font-medium tabular-nums">
                      {formatUsdc(refundAmount)}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between border-t border-border/60 pt-2">
                  <span className="text-muted-foreground">Delegate</span>
                  <span className="font-mono text-xs">
                    {delegate.slice(0, 6)}…{delegate.slice(-4)}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Refund</span>
                <span className="font-medium tabular-nums">
                  {formatUsdc(refundPathAmount)}
                </span>
              </div>
            )}
          </div>

          <StepFooter
            onBack={() => setStep(mode === 'arm' ? 'delegate' : 'review')}
            onNext={() => runClaim(mode)}
            nextLabel={mode === 'arm' ? 'Claim ARM' : 'Claim refund'}
          />
        </div>
      )}

      {step === 'status' && (
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-base font-medium text-foreground">
              {pipelineRunning
                ? 'Submitting your claim'
                : pipelineError
                ? 'Something went wrong'
                : pipelineDone
                ? 'Claim submitted!'
                : 'Preparing transaction'}
            </div>
            <div className="text-sm text-muted-foreground">
              {pipelineRunning
                ? 'Confirm in your wallet. The page will update once your transaction confirms.'
                : pipelineDone
                ? mode === 'arm'
                  ? 'Your ARM tokens have been claimed and delegated.'
                  : 'Your USDC refund has been sent.'
                : null}
            </div>
          </div>

          <TxStatusPipeline rows={pipeline} />

          <StepFooter
            onBack={pipelineRunning ? undefined : () => setStep('confirm')}
            onNext={pipelineDone ? resetFlow : undefined}
            backLabel="Back"
            nextLabel="Done"
            nextVariant="outline"
            hideNext={!pipelineDone && !pipelineError}
          />
        </div>
      )}
    </Stepper>
  )
}
