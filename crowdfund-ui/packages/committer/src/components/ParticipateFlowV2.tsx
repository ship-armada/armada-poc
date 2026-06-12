// ABOUTME: v2 Participate flow page-level controller — wires the designer's Step1–Step5 screens to the committer's eligibility/balance/tx hooks.
// ABOUTME: Multi-hop aware — per-hop amount entry, single approve(total) + one commit(hop, amount) per non-zero hop. Real approve + commit transactions through the controlled Step4Approve.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ConnectButton, useConnectModal } from '@rainbow-me/rainbowkit'
import { useDisconnect } from 'wagmi'
import { Contract, type Signer } from 'ethers'
import {
  ParticipateFlowInviteSlots,
  Step0Invite,
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
  type HopVariant,
} from '@armada/crowdfund-shared'
import { getHubNetworkLabel } from '@/config/network'
import { useTxPipeline, type TxStep } from '@/hooks/useTxPipeline'
import type { HopPosition } from '@/hooks/useEligibility'

type FlowStep = 'wallet' | 'splash' | 'commit' | 'review' | 'approve' | 'confirmation' | 'invites'

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
  /** Notifies the parent when the approve/commit pipeline starts/stops, so the
   *  enclosing modal can confirm before closing mid-transaction. */
  onRunningChange?: (running: boolean) => void
  /** True while contract events are still hydrating. Avoids flashing the
   *  "not whitelisted" screen at an eligible user before their positions load. */
  eventsLoading?: boolean
  /** Days remaining in the commit window — shown on the first-time splash card. */
  daysLeft?: number
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
  onRunningChange,
  eventsLoading,
  daysLeft,
}: ParticipateFlowV2Props) {
  // The approve+commit pipeline lives in an address-keyed store so it survives a
  // modal close (re-attaching on reopen), pauses (rather than prompting) while
  // detached, and can't run twice for one address.
  const pipeline = useTxPipeline(walletAddress)
  const phase = pipeline.state.phase
  const submitting = phase === 'running' || phase === 'paused'
  // Latest phase + a stable reset handle, read by the close-cleanup below.
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const resetPipeline = pipeline.reset
  // Re-attach: reopening while a pipeline is live lands directly on the tx surface.
  const [step, setStep] = useState<FlowStep>(
    phase === 'success' ? 'confirmation' : submitting ? 'approve' : 'wallet',
  )
  const [amounts, setAmounts] = useState<AmountsByHop>(EMPTY_AMOUNTS)
  // Defensive guard error when the user confirms with no signer/amount — shown
  // as a Step4 error row without involving the pipeline store.
  const [attemptError, setAttemptError] = useState<string | null>(null)
  const { disconnect } = useDisconnect()
  const { openConnectModal } = useConnectModal()

  // Surface in-flight status so the modal can confirm before closing. The
  // cleanup resets the parent's flag on unmount — the pipeline keeps running in
  // the store, and reopening the modal re-derives the flag from its phase.
  useEffect(() => {
    onRunningChange?.(submitting)
    return () => onRunningChange?.(false)
  }, [submitting, onRunningChange])

  // Advance to confirmation once the pipeline completes — works even if it
  // finished while the modal was closed (re-attach reads `success`).
  useEffect(() => {
    if (phase !== 'success' || step !== 'approve') return
    const t = setTimeout(() => setStep('confirmation'), 600)
    return () => clearTimeout(t)
  }, [phase, step])

  // A wallet rejection returns the flow to review (quiet — no red error row).
  useEffect(() => {
    if (phase !== 'rejected') return
    setStep('review')
    pipeline.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // On close, clear a finished/errored pipeline so reopening starts a fresh
  // commit instead of re-attaching to the now-stale confirmation screen. A
  // running/paused pipeline is left intact so it survives the close and
  // re-attaches on reopen.
  useEffect(() => {
    return () => {
      if (phaseRef.current !== 'running' && phaseRef.current !== 'paused') {
        resetPipeline()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Snapshot of committed USDC + capped demand at the moment the user entered
  // the flow with events loaded. Captured once — on the first render where
  // `eventsLoading` is false — into a ref, so it stays stable for the rest of
  // the flow (Step5's first-time-vs-additional copy, Step2's remaining cap) and
  // is immune to the post-confirmation `ingestReceiptLogs` bump. Opening the
  // modal mid-hydration no longer freezes the baselines at zero.
  const baselinesRef = useRef<{
    initialCommittedByHop: AmountsByHop
    baselineCommittedByHopUsdc: Record<0 | 1 | 2, bigint>
    baselineCappedDemand: bigint
  } | null>(null)
  if (baselinesRef.current === null && !eventsLoading) {
    const committedByHop: AmountsByHop = { 0: 0, 1: 0, 2: 0 }
    const committedByHopUsdc: Record<0 | 1 | 2, bigint> = { 0: 0n, 1: 0n, 2: 0n }
    for (const p of renderablePositions) {
      committedByHop[p.hop] = usdcToNumber(p.committed)
      committedByHopUsdc[p.hop] = p.committed
    }
    baselinesRef.current = {
      initialCommittedByHop: committedByHop,
      baselineCommittedByHopUsdc: committedByHopUsdc,
      baselineCappedDemand: cappedDemand,
    }
  }
  const { initialCommittedByHop, baselineCommittedByHopUsdc, baselineCappedDemand } =
    baselinesRef.current ?? {
      initialCommittedByHop: EMPTY_AMOUNTS,
      baselineCommittedByHopUsdc: { 0: 0n, 1: 0n, 2: 0n } as Record<0 | 1 | 2, bigint>,
      baselineCappedDemand: cappedDemand,
    }
  const initialCommittedTotal = Object.values(initialCommittedByHop).reduce((s, v) => s + v, 0)
  const isAdditionalCommit = initialCommittedTotal > 0

  // Was the participant already at their cap on every eligible hop when they
  // entered? Then there's nothing left to commit — we skip the input step and
  // land them on the confirmation screen with "already fully committed" copy.
  const isFullyCommitted = useMemo(
    () =>
      renderablePositions.length > 0 &&
      renderablePositions.every(
        (p) =>
          baselineCommittedByHopUsdc[p.hop] > 0n &&
          baselineCommittedByHopUsdc[p.hop] >= p.effectiveCap,
      ),
    [renderablePositions, baselineCommittedByHopUsdc],
  )

  // First-time participants see the "join the fleet" splash card before the
  // commit input; returning/additional committers skip straight to commit.
  const showSplash = !isAdditionalCommit
  const splashHopVariant: HopVariant = isMulti
    ? 'multi-hop'
    : primaryPosition
      ? (['seed', 'hop-1', 'hop-2'] as const)[primaryPosition.hop]
      : 'hop-1'

  // Auto-advance once the wallet connects: first-timers to the splash, everyone
  // else to commit. Disconnecting falls back to the wallet step. If a returning
  // participant briefly landed on the splash before their positions hydrated,
  // bump them onward.
  useEffect(() => {
    if (!walletConnected) {
      if (step !== 'wallet') setStep('wallet')
      return
    }
    if (step === 'wallet') {
      setStep(showSplash ? 'splash' : 'commit')
    } else if (step === 'splash' && !showSplash) {
      setStep('commit')
    }
  }, [walletConnected, step, showSplash])

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

  // ARM reserved for the participant's existing committed position (no new
  // commit). Shown on the "already fully committed" confirmation, where the
  // pro-rata `estimatedArm` above is 0 (no new amount entered).
  const committedArmEstimate = useMemo(() => {
    if (renderablePositions.length === 0) return 0
    const positions: UserHopPosition[] = renderablePositions.map((p) => ({
      hop: p.hop,
      committed: baselineCommittedByHopUsdc[p.hop],
      effectiveCap: p.effectiveCap,
    }))
    return armToNumber(
      estimateUserArmAllocation(positions, hopStats, baselineCappedDemand, saleSize),
    )
  }, [renderablePositions, baselineCommittedByHopUsdc, hopStats, baselineCappedDemand, saleSize])

  // The confirmation screen, shared by the normal post-commit path and the
  // "already fully committed" shortcut. `maxedOut` swaps in the no-new-commit
  // copy and shows the ARM reserved for the existing position.
  const renderConfirmation = () => (
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
      estimatedArm={isFullyCommitted ? committedArmEstimate : estimatedArm}
      isAdditionalCommit={isAdditionalCommit}
      totalCommittedUsdc={initialCommittedTotal + totalNewAmountUsd}
      maxedOut={isFullyCommitted}
    />
  )

  // Build the approve(total) + N×commit(hop, amount) tx list. The approve covers
  // the sum so the user signs one allowance bump even on a multi-hop commit;
  // each non-zero hop gets its own commit. Ordered SEED → HOP-1 → HOP-2 to match
  // Step3Review. The pipeline store runs them sequentially and stops at any
  // failing row.
  const buildSteps = (): TxStep[] => {
    const totalBig = totalNewAmountUsdc
    const steps: TxStep[] = []
    if (needsApproval(totalBig)) {
      steps.push({
        label: `Approve ${formatUsdc(totalBig)} USDC`,
        send: () =>
          new Contract(usdcAddress!, ERC20_ABI_FRAGMENTS, signer!).approve(crowdfundAddress!, totalBig),
        // Re-read allowance so the next attempt's skip-approval decision is real.
        after: refreshAllowance,
      })
    }
    for (const p of renderablePositions) {
      const amount = amounts[p.hop] ?? 0
      if (amount <= 0) continue
      const amountBig = numberToUsdc(amount)
      steps.push({
        label: isMulti
          ? `Commit ${HOP_LABELS[p.hop]} (${formatUsdc(amountBig)})`
          : 'Commit participation',
        send: () =>
          new Contract(crowdfundAddress!, CROWDFUND_ABI_FRAGMENTS, signer!).commit(p.hop, amountBig),
        onReceipt: (logs) => onReceiptLogs?.(logs),
      })
    }
    return steps
  }

  // Start (or retry) the pipeline. A defensive guard surfaces an actionable
  // error row instead of dropping into Step4's neutral state with nothing sent.
  const startPipeline = () => {
    if (!signer || !crowdfundAddress || !usdcAddress || totalNewAmountUsd <= 0) {
      setAttemptError('Wallet not ready — reconnect and retry.')
      return
    }
    setAttemptError(null)
    if (phase === 'error') {
      pipeline.retry()
      return
    }
    pipeline.run(buildSteps(), {
      // Refresh balance + allowance so the navbar badge and any subsequent open
      // see the post-commit numbers and don't skip approval on stale allowance.
      onSuccess: () => {
        void refreshAllowance()
      },
    })
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
    // Events still hydrating — don't flash the rejection screen at an eligible
    // user before their on-chain positions have loaded.
    if (eventsLoading) {
      return (
        <div className="flex min-h-[200px] items-center justify-center p-6 text-muted-foreground">
          Checking eligibility…
        </div>
      )
    }
    return (
      <Step1WalletNotWhitelisted
        address={walletAddress ?? '0x0000000000000000000000000000000000000000'}
        onSelectAnother={() => {
          // The button says "Connect a different wallet" — make it honest:
          // disconnect the current address and reopen the wallet picker.
          disconnect()
          openConnectModal?.()
        }}
      />
    )
  }

  if (step === 'splash') {
    return (
      <Step0Invite
        hopVariant={splashHopVariant}
        daysLeft={daysLeft}
        hideConnectEyebrow
        onJoin={() => setStep('commit')}
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
    // Already at the cap on every eligible hop — nothing to enter. Skip straight
    // to the confirmation screen so the stepper, "What's next", and Invite
    // options render (instead of a dead-end "fully committed" message).
    if (isFullyCommitted) {
      return renderConfirmation()
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
          onBack={() => (showSplash ? setStep('splash') : onGoToNetwork())}
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
        onBack={() => (showSplash ? setStep('splash') : onGoToNetwork())}
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
            setStep('approve')
            startPipeline()
          }}
          onBack={() => setStep('commit')}
          disabled={submitting}
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
          setStep('approve')
          startPipeline()
        }}
        onBack={() => setStep('commit')}
        disabled={submitting}
        hopLevel={HOP_LABELS[primaryPosition.hop]}
        amount={totalNewAmountUsd}
        estimatedArm={estimatedArm}
      />
    )
  }

  if (step === 'approve') {
    // Guard error (no signer/amount) renders as a standalone error row; otherwise
    // the rows come live from the pipeline store.
    const rows: Step4Transaction[] = attemptError
      ? [{ label: 'Commit participation', status: 'error', errorMessage: attemptError }]
      : pipeline.state.rows
    return (
      <Step4Approve
        amount={totalNewAmountUsd}
        txs={rows.length ? rows : undefined}
        onDone={() => setStep('confirmation')}
        onBack={() => {
          // Return to review with entered amounts preserved (amounts state is
          // untouched). Reset the pipeline so a fresh confirm starts clean.
          pipeline.reset()
          setAttemptError(null)
          setStep('review')
        }}
        onRetry={() => {
          // Resume from the failed row (a succeeded approve isn't repeated).
          startPipeline()
        }}
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
  return renderConfirmation()
}
