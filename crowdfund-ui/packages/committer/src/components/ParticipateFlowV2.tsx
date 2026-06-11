// ABOUTME: v2 Participate flow page-level controller — wires the designer's Step1–Step5 screens to the committer's eligibility/balance/tx hooks.
// ABOUTME: Multi-hop aware — per-hop amount entry, single approve(total) + one commit(hop, amount) per non-zero hop. Real approve + commit transactions through the controlled Step4Approve.

import { useEffect, useMemo, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Contract, type Signer, type TransactionResponse } from 'ethers'
import {
  ParticipateFlowInviteSlots,
  Step1Connect,
  Step1SwitchNetwork,
  Step1WalletNotWhitelisted,
  Step2Commit,
  Step3Review,
  Step4Approve,
  Step5Confirmation,
  hopPillDotColor,
  type CrowdfundInviteSlotSection,
  type ReceiptLogLike,
  type Step2CommitHopRow,
  type Step3ReviewHopCommit,
  type Step4Transaction,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  formatUsdc,
  formatUsdcPlain,
  estimateUserArmAllocation,
  type UserHopPosition,
  type HopStatsData,
} from '@armada/crowdfund-shared'
import { mapRevertToMessage } from '@/lib/revertMessages'
import { TX_WAIT_TIMEOUT_MS, TX_PENDING_MESSAGE, isTxTimeoutError } from '@/lib/txWait'
import { getHubNetworkLabel } from '@/config/network'
import type { HopPosition } from '@/hooks/useEligibility'

type FlowStep = 'wallet' | 'commit' | 'review' | 'approve' | 'confirmation' | 'invites'

export interface ParticipateFlowV2Props {
  walletConnected: boolean
  walletAddress: string | null
  signer: Signer | null
  positions: HopPosition[]
  balance: bigint
  needsApproval: (amount: bigint) => boolean
  refreshAllowance: () => Promise<void>
  crowdfundAddress: string | null
  usdcAddress: string | null
  hopStats: HopStatsData[]
  saleSize: bigint
  cappedDemand: bigint
  windowOpen: boolean
  onGoToMyPosition: () => void
  onGoToNetwork: () => void
  /** Live per-hop invite-slot sections. When non-empty, clicking Invite on
   *  the confirmation step opens the invite-slots screen inside the modal
   *  (matching the designer's reference). When omitted / empty (e.g. user
   *  not eligible at any hop), Invite falls back to navigating to My
   *  Position. */
  inviteSlotSections?: ReadonlyArray<CrowdfundInviteSlotSection>
  /** Hook for ingesting commit-tx receipt logs straight into the event store
   *  so the graph state (per-node committed totals, MyPosition stats) refreshes
   *  immediately on confirmation instead of waiting for the next event poll.
   *  Mirrors how v1 `CommitTab` plugs into `useContractEvents.ingestReceiptLogs`. */
  onReceiptLogs?: (logs: readonly ReceiptLogLike[]) => void
}

// Convert a bigint USDC amount (6 decimals) into a plain number for the
// designer's step components (which take amounts as numbers). Loses precision
// past 2 decimals — acceptable for display + range checks, not for tx params.
function usdcToNumber(amount: bigint): number {
  return Number(formatUsdcPlain(amount))
}

// Convert a number USD amount back into a bigint USDC (6 decimals) for tx params.
function numberToUsdc(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000))
}

// Convert a bigint ARM amount (18 decimals) into a plain number for display.
// ARM uses standard ERC20 18-decimal precision, distinct from USDC's 6.
function armToNumber(amount: bigint): number {
  // Split into integer + fractional to avoid precision loss past Number.MAX_SAFE_INTEGER.
  const whole = amount / 10n ** 18n
  const frac = amount % 10n ** 18n
  return Number(whole) + Number(frac) / 1e18
}

const HOP_LABELS = ['SEED', 'HOP-1', 'HOP-2'] as const
const HOP_DOT_KEYS = ['seed', 'hop-1', 'hop-2'] as const

type AmountsByHop = Record<0 | 1 | 2, number>
const EMPTY_AMOUNTS: AmountsByHop = { 0: 0, 1: 0, 2: 0 }

export function ParticipateFlowV2({
  walletConnected,
  walletAddress,
  signer,
  positions,
  balance,
  needsApproval,
  refreshAllowance,
  crowdfundAddress,
  usdcAddress,
  hopStats,
  saleSize,
  cappedDemand,
  windowOpen,
  onGoToMyPosition,
  onGoToNetwork,
  inviteSlotSections,
  onReceiptLogs,
}: ParticipateFlowV2Props) {
  const [step, setStep] = useState<FlowStep>('wallet')
  const [amounts, setAmounts] = useState<AmountsByHop>(EMPTY_AMOUNTS)
  const [txs, setTxs] = useState<Step4Transaction[] | null>(null)

  // Eligible positions, filtered to renderable hops and ordered ascending.
  // Drives the per-hop entry rows in Step2 and the per-hop summary in Step3.
  const renderablePositions = useMemo(() => {
    return positions
      .filter((p): p is HopPosition & { hop: 0 | 1 | 2 } =>
        p.hop === 0 || p.hop === 1 || p.hop === 2,
      )
      .sort((a, b) => a.hop - b.hop)
  }, [positions])
  const eligible = renderablePositions.length > 0
  const isMulti = renderablePositions.length > 1
  const primaryPosition = renderablePositions[0] ?? null

  // Sum of the in-flow amounts (this flow's new commits, across all hops).
  // Drives the approve tx + the wallet-balance constraint.
  const totalNewAmountUsd = useMemo(
    () => renderablePositions.reduce((sum, p) => sum + (amounts[p.hop] ?? 0), 0),
    [amounts, renderablePositions],
  )
  const totalNewAmountUsdc = useMemo(
    () => numberToUsdc(totalNewAmountUsd),
    [totalNewAmountUsd],
  )

  // Snapshot of committed USDC at the moment the user entered the flow.
  // Captured per-hop and rolled up so Step5 can decide first-time-commit vs
  // additional-commit copy without flickering when chain events refresh
  // mid-flow.
  const initialCommittedByHop = useMemo<AmountsByHop>(() => {
    const out: AmountsByHop = { 0: 0, 1: 0, 2: 0 }
    for (const p of renderablePositions) out[p.hop] = usdcToNumber(p.committed)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const initialCommittedTotal = useMemo(
    () => Object.values(initialCommittedByHop).reduce((s, v) => s + v, 0),
    [initialCommittedByHop],
  )
  const baselineCommittedByHopUsdc = useMemo<Record<0 | 1 | 2, bigint>>(() => {
    const out: Record<0 | 1 | 2, bigint> = { 0: 0n, 1: 0n, 2: 0n }
    for (const p of renderablePositions) out[p.hop] = p.committed
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const baselineCappedDemand = useMemo(() => {
    return cappedDemand
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const isAdditionalCommit = initialCommittedTotal > 0

  // Auto-advance past the wallet step when the user lands here with a wallet
  // already connected. When they disconnect, fall back.
  useEffect(() => {
    if (walletConnected && step === 'wallet') setStep('commit')
    if (!walletConnected && step !== 'wallet') setStep('wallet')
  }, [walletConnected, step])

  // Pro-rata estimate of ARM allocation at the proposed commit amounts.
  // Aggregates across all hops via the shared `estimateUserArmAllocation`
  // helper. Uses mount-time baselines (per-hop committed + global capped
  // demand) so the projection stays stable across the flow and is immune
  // to the `ingestReceiptLogs` post-confirmation bump.
  const estimatedArm = useMemo(() => {
    if (renderablePositions.length === 0 || totalNewAmountUsd <= 0) return 0
    const projectedPositions: UserHopPosition[] = renderablePositions.map((p) => ({
      hop: p.hop,
      committed:
        baselineCommittedByHopUsdc[p.hop] + numberToUsdc(amounts[p.hop] ?? 0),
      effectiveCap: p.effectiveCap,
    }))
    const armAllocation = estimateUserArmAllocation(
      projectedPositions,
      hopStats,
      baselineCappedDemand + totalNewAmountUsdc,
      saleSize,
    )
    return armToNumber(armAllocation)
  }, [
    renderablePositions,
    amounts,
    totalNewAmountUsd,
    totalNewAmountUsdc,
    hopStats,
    baselineCappedDemand,
    baselineCommittedByHopUsdc,
    saleSize,
  ])

  // Run the real approve + N×commit pipeline. The approve covers the sum of
  // all per-hop amounts so the user signs one allowance bump even on a
  // multi-hop commit. Each non-zero hop gets its own commit tx; failures
  // stop the pipeline at the failing row.
  const runPipeline = async () => {
    if (!signer || !crowdfundAddress || !usdcAddress || totalNewAmountUsd <= 0) {
      // Don't bail silently into Step4's neutral state — surface an actionable
      // error row so the user reconnects rather than waiting on nothing.
      setTxs([
        {
          label: 'Commit participation',
          status: 'error',
          errorMessage: 'Wallet not ready — reconnect and retry.',
        },
      ])
      return
    }
    const totalBig = totalNewAmountUsdc
    const approveLabel = `Approve ${formatUsdc(totalBig)} USDC`
    const skipApproval = !needsApproval(totalBig)

    // One commit row per non-zero hop, ordered ascending so the user reads
    // SEED → HOP-1 → HOP-2 top-down (matches Step3Review's order).
    const commits = renderablePositions
      .filter((p) => (amounts[p.hop] ?? 0) > 0)
      .map((p) => ({
        hop: p.hop,
        amountBig: numberToUsdc(amounts[p.hop]),
        label: isMulti
          ? `Commit ${HOP_LABELS[p.hop]} (${formatUsdc(numberToUsdc(amounts[p.hop]))})`
          : 'Commit participation',
      }))

    const initial: Step4Transaction[] = [
      ...(skipApproval ? [] : [{ label: approveLabel, status: 'loading' as const }]),
      ...commits.map((c, i) => ({
        label: c.label,
        status: (skipApproval && i === 0 ? 'loading' : 'pending') as Step4Transaction['status'],
      })),
    ]
    setTxs(initial)

    const setRowStatus = (
      index: number,
      patch: Partial<Step4Transaction>,
    ) => {
      setTxs((prev) => {
        if (!prev) return prev
        const next = prev.slice()
        next[index] = { ...next[index], ...patch }
        return next
      })
    }

    const sendAndWait = async (
      index: number,
      label: string,
      send: () => Promise<TransactionResponse>,
      onSuccess?: (logs: readonly ReceiptLogLike[]) => void,
    ): Promise<boolean> => {
      setRowStatus(index, { label, status: 'loading' })
      let txHash: string | undefined
      try {
        const tx = await send()
        txHash = tx.hash
        const receipt = await tx.wait(1, TX_WAIT_TIMEOUT_MS)
        if (!receipt || receipt.status === 0) {
          setRowStatus(index, { status: 'error', errorMessage: 'Transaction reverted' })
          return false
        }
        setRowStatus(index, { status: 'done' })
        onSuccess?.(receipt.logs as unknown as readonly ReceiptLogLike[])
        return true
      } catch (err) {
        if (isTxTimeoutError(err)) {
          // The tx may still confirm — surface it as pending, never as success,
          // and never auto-resubmit.
          setRowStatus(index, {
            status: 'error',
            errorMessage: TX_PENDING_MESSAGE,
            errorDetails: txHash ? `Transaction hash: ${txHash}` : undefined,
          })
          return false
        }
        setRowStatus(index, {
          status: 'error',
          errorMessage: mapRevertToMessage(err),
          errorDetails: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    }

    let pipelineIndex = 0
    if (!skipApproval) {
      const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, signer)
      const ok = await sendAndWait(pipelineIndex, approveLabel, () =>
        usdc.approve(crowdfundAddress, totalBig),
      )
      if (!ok) return
      await refreshAllowance()
      pipelineIndex += 1
    }

    const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
    for (const commit of commits) {
      const ok = await sendAndWait(
        pipelineIndex,
        commit.label,
        () => crowdfund.commit(commit.hop, commit.amountBig),
        (logs) => onReceiptLogs?.(logs),
      )
      if (!ok) return
      pipelineIndex += 1
    }

    // Refresh balance + allowance so the navbar wallet badge and any
    // subsequent modal open with the post-commit numbers and don't try to
    // skip approval based on the now-consumed allowance.
    await refreshAllowance()

    setTimeout(() => setStep('confirmation'), 600)
  }

  // ── Step renderers ───────────────────────────────────────────────

  if (step === 'wallet') {
    return (
      <ConnectButton.Custom>
        {({ account, chain, openConnectModal, openChainModal }) => {
          if (!account || !chain) {
            return (
              <Step1Connect
                compact
                showSteps={false}
                onConnect={() => openConnectModal()}
              />
            )
          }
          if (chain.unsupported) {
            return (
              <Step1SwitchNetwork
                compact
                showSteps={false}
                networkLabel={getHubNetworkLabel()}
                onSwitch={() => openChainModal()}
              />
            )
          }
          // Connected + correct chain: the connect step auto-advances to commit.
          return null
        }}
      </ConnectButton.Custom>
    )
  }

  if (!eligible) {
    return (
      <Step1WalletNotWhitelisted
        address={walletAddress ?? '0x0000000000000000000000000000000000000000'}
        onSelectAnother={onGoToNetwork}
      />
    )
  }

  if (step === 'commit') {
    if (!windowOpen) {
      return (
        <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-4 text-center">
          <div className="text-2xl">Commit window isn't open</div>
          <div className="text-muted-foreground">
            New commits aren't accepted right now. Check back when the campaign opens.
          </div>
        </div>
      )
    }
    if (isMulti) {
      // Multi-hop: stacked per-hop input rows. Single-hop falls through to
      // the legacy big-number variant below for an unchanged UX.
      const hopRows: Step2CommitHopRow[] = renderablePositions.map((p) => ({
        hop: p.hop,
        hopLabel: HOP_LABELS[p.hop],
        hopColor: hopPillDotColor(HOP_DOT_KEYS[p.hop]),
        maxAmount: usdcToNumber(p.effectiveCap),
        existingCommittedUsdc: initialCommittedByHop[p.hop],
      }))
      return (
        <Step2Commit
          hopRows={hopRows}
          availableBalance={usdcToNumber(balance)}
          onNext={() => {}}
          onNextMulti={(next) => {
            setAmounts({ 0: next[0] ?? 0, 1: next[1] ?? 0, 2: next[2] ?? 0 })
            setStep('review')
          }}
          onBack={onGoToNetwork}
        />
      )
    }
    // Single-hop path — identical to pre-multi-hop UX.
    if (!primaryPosition) return null
    const effectiveCapUsd = usdcToNumber(primaryPosition.effectiveCap)
    const availableBalance = usdcToNumber(balance)
    return (
      <Step2Commit
        onNext={(amt) => {
          setAmounts({
            0: primaryPosition.hop === 0 ? amt : 0,
            1: primaryPosition.hop === 1 ? amt : 0,
            2: primaryPosition.hop === 2 ? amt : 0,
          })
          setStep('review')
        }}
        onBack={onGoToNetwork}
        maxAmount={effectiveCapUsd}
        availableBalance={availableBalance}
        maxArm={effectiveCapUsd}
        existingCommittedUsdc={initialCommittedByHop[primaryPosition.hop]}
        hopLabel={HOP_LABELS[primaryPosition.hop]}
        hopColor={hopPillDotColor(HOP_DOT_KEYS[primaryPosition.hop])}
      />
    )
  }

  if (step === 'review') {
    if (isMulti) {
      const hopCommits: Step3ReviewHopCommit[] = renderablePositions
        .filter((p) => (amounts[p.hop] ?? 0) > 0)
        .map((p) => ({
          hop: p.hop,
          hopLabel: HOP_LABELS[p.hop],
          hopColor: hopPillDotColor(HOP_DOT_KEYS[p.hop]),
          amount: amounts[p.hop],
        }))
      return (
        <Step3Review
          onNext={() => {
            setTxs(null)
            setStep('approve')
            void runPipeline()
          }}
          onBack={() => setStep('commit')}
          hopCommits={hopCommits}
          amount={totalNewAmountUsd}
          estimatedArm={estimatedArm}
        />
      )
    }
    if (!primaryPosition) return null
    return (
      <Step3Review
        onNext={() => {
          setTxs(null)
          setStep('approve')
          void runPipeline()
        }}
        onBack={() => setStep('commit')}
        hopLevel={HOP_LABELS[primaryPosition.hop]}
        amount={totalNewAmountUsd}
        estimatedArm={estimatedArm}
      />
    )
  }

  if (step === 'approve') {
    return (
      <Step4Approve
        amount={totalNewAmountUsd}
        txs={txs ?? undefined}
        onDone={() => setStep('confirmation')}
      />
    )
  }

  if (step === 'invites') {
    if (inviteSlotSections && inviteSlotSections.length > 0) {
      return (
        <ParticipateFlowInviteSlots
          sections={inviteSlotSections}
          onDoItLater={onGoToMyPosition}
        />
      )
    }
    onGoToMyPosition()
    return null
  }

  // step === 'confirmation'
  const totalCommittedUsdc = initialCommittedTotal + totalNewAmountUsd
  return (
    <Step5Confirmation
      onViewPosition={onGoToMyPosition}
      onInvite={() => {
        if (inviteSlotSections && inviteSlotSections.length > 0) {
          setStep('invites')
        } else {
          onGoToMyPosition()
        }
      }}
      amount={totalNewAmountUsd}
      estimatedArm={estimatedArm}
      isAdditionalCommit={isAdditionalCommit}
      totalCommittedUsdc={totalCommittedUsdc}
    />
  )
}
