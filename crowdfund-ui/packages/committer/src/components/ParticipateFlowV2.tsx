// ABOUTME: v2 Participate flow page-level controller — wires the designer's Step1–Step5 screens to the committer's eligibility/balance/tx hooks.
// ABOUTME: Multi-hop aware — per-hop amount entry, single approve(total) + one commit(hop, amount) per non-zero hop. Real approve + commit transactions through the controlled Step4Approve.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ConnectButton, useConnectModal } from '@rainbow-me/rainbowkit'
import { useDisconnect } from 'wagmi'
import { Contract, type JsonRpcProvider, type Signer } from 'ethers'
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
  StepBeforeYouStart,
  confirmParticipateClose,
  MaxOutBanner,
  MaxOutFlowStack,
  hopPillDotColor,
  truncateAddress,
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
import { FooterSocials } from '@/components/FooterSocials'
import { getHubNetworkLabel, getExplorerUrl } from '@/config/network'
import { resolveSigner, describeSignerError } from '@/lib/resolveSigner'
import { countFreeInviteSlots, hasFreeInviteSlot } from '@/lib/inviteSlots'
import { commitTxHashFromRows } from '@/lib/commitTxHash'
import { submitWrite } from '@/lib/submitWrite'
import { useTxPipeline, type TxStep } from '@/hooks/useTxPipeline'
import { useSelfFill } from '@/hooks/useSelfFill'
import { useResetPipelineOnClose } from '@/hooks/useResetPipelineOnClose'
import type { HopPosition } from '@/hooks/useEligibility'

type FlowStep =
  | 'wallet'
  | 'splash'
  | 'beforeYouStart'
  | 'commit'
  | 'review'
  | 'approve'
  | 'confirmation'
  | 'invites'

// Steps whose screen draws its own FlowChrome (back + close). On those the
// modal drops its X so there is exactly one close control; everywhere else
// (connect, eligibility, invite slots) the modal keeps it so nobody is trapped.
const CHROME_STEPS: ReadonlySet<FlowStep> = new Set<FlowStep>([
  'beforeYouStart',
  'commit',
  'review',
  'approve',
  'confirmation',
])

export interface ParticipateFlowV2Props {
  walletConnected: boolean
  walletAddress: string | null
  signer: Signer | null
  /** Read provider for the self-fill ("max out") plan's fresh on-chain state read.
   *  Optional — the max-out path is simply unavailable without it. */
  provider?: JsonRpcProvider | null
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
  /** Close the flow without navigating — wired to the FlowChrome X on every
   *  commit step. Falls back to `onGoToNetwork` when the parent omits it. */
  onClose?: () => void
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
  /** Whether the enclosing modal should render its own close (X). False on the
   *  steps that draw a FlowChrome close of their own. */
  onModalCloseChange?: (showClose: boolean) => void
  /** True while contract events are still hydrating. Avoids flashing the
   *  "not whitelisted" screen at an eligible user before their positions load. */
  eventsLoading?: boolean
  /** Seconds remaining in the commit window — shown on the first-time splash card. */
  secondsLeft?: number
  /** Absolute commit-window deadline (unix seconds) — the "Window closes" row
   *  on Before you start. */
  windowEndUnix?: number
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

const HOP_LABELS = ['HOP-0', 'HOP-1', 'HOP-2'] as const
const HOP_DOT_KEYS = ['seed', 'hop-1', 'hop-2'] as const

type AmountsByHop = Record<0 | 1 | 2, number>
const EMPTY_AMOUNTS: AmountsByHop = { 0: 0, 1: 0, 2: 0 }

// "Window closes" value on Before you start. An em dash rather than a guessed
// date when the deadline hasn't loaded — the screen's own default is demo copy.
function formatWindowCloses(windowEndUnix: number | undefined): string {
  if (!windowEndUnix || windowEndUnix <= 0) return '—'
  return new Date(windowEndUnix * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function ParticipateFlowV2({
  walletConnected,
  walletAddress,
  signer,
  provider,
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
  onClose,
  inviteSlotSections,
  onReceiptLogs,
  onRunningChange,
  onModalCloseChange,
  eventsLoading,
  secondsLeft,
  windowEndUnix,
}: ParticipateFlowV2Props) {
  // The approve+commit pipeline lives in an address-keyed store so it survives a
  // modal close (re-attaching on reopen), pauses (rather than prompting) while
  // detached, and can't run twice for one address.
  const pipeline = useTxPipeline(walletAddress)
  const phase = pipeline.state.phase
  const submitting = phase === 'running' || phase === 'paused'
  // Clear a finished pipeline when the modal closes so reopening starts fresh.
  useResetPipelineOnClose(pipeline)
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

  // Close the flow in place (no page change) — the FlowChrome X on every commit
  // step. Without a parent handler, leaving via the network page is the next
  // best exit. Mid-pipeline it asks first, like the modal's own X / Escape.
  const handleClose = () => {
    if (!confirmParticipateClose(submitting)) return
    if (onClose) onClose()
    else onGoToNetwork()
  }

  // A step only owns the close control when it actually renders a FlowChrome:
  // the eligibility gates below pre-empt the step machine, and the commit step
  // degrades to a plain "window isn't open" message.
  const stepOwnsChrome =
    walletConnected && eligible && CHROME_STEPS.has(step) && (step !== 'commit' || windowOpen)
  const showModalClose = !stepOwnsChrome && step !== 'splash'

  useEffect(() => {
    onModalCloseChange?.(showModalClose)
    return () => onModalCloseChange?.(true)
  }, [showModalClose, onModalCloseChange])

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

  // "Hop limit" on Before you start — summed across eligible hops so a
  // multi-hop wallet sees its whole allowance, not just the first hop's.
  const totalCapUsd = useMemo(
    () => renderablePositions.reduce((sum, p) => sum + usdcToNumber(p.effectiveCap), 0),
    [renderablePositions],
  )
  const freeInviteSlots = useMemo(
    () => countFreeInviteSlots(inviteSlotSections),
    [inviteSlotSections],
  )

  // Auto-advance once the wallet connects: first-timers to the splash, everyone
  // else to commit. Disconnecting falls back to the wallet step. If a returning
  // participant briefly landed on the intro screens before their positions
  // hydrated, bump them onward.
  useEffect(() => {
    if (!walletConnected) {
      if (step !== 'wallet') setStep('wallet')
      return
    }
    if (step === 'wallet') {
      setStep(showSplash ? 'splash' : 'commit')
    } else if ((step === 'splash' || step === 'beforeYouStart') && !showSplash) {
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

  // ── Self-fill ("max out") ────────────────────────────────────────
  // Shared controller: preview plan + banner option, fresh-read activation
  // (advances to review via onActivated), and the bundled-pipeline helpers.
  const {
    maxOutOption,
    maxMode,
    maxPlan,
    maxNewCommitUsd,
    maxEstimatedArm,
    resetMax,
    buildMaxSteps,
    maxConfirmation,
  } = useSelfFill({
    positions: renderablePositions,
    balance,
    provider,
    walletAddress,
    crowdfundAddress,
    usdcAddress,
    hopStats,
    cappedDemand: baselineCappedDemand,
    saleSize,
    needsApproval,
    refreshAllowance,
    onReceiptLogs,
    windowOpen,
    isAdditionalCommit,
    onActivated: () => setStep('review'),
  })

  // The confirmation screen, shared by the normal post-commit path and the
  // "already fully committed" shortcut. `maxedOut` swaps in the no-new-commit
  // copy and shows the ARM reserved for the existing position.
  const renderConfirmation = () => {
    const inMax = maxMode && !!maxPlan
    // Prefer the snapshot captured at run() time. It survives a modal
    // close/reopen across the tx, where the local amount / maxPlan state does
    // not. Absent (e.g. the `isFullyCommitted` shortcut never runs a pipeline),
    // fall back to live local state.
    const snap = pipeline.state.confirmation
    return (
      // Banner hoisted ABOVE the card on desktop; mobile shows it inside Step2Commit.
      // When commit headroom still remains (fully committed at current caps but
      // self-fill can raise them, or a partial commit), it offers Max out here
      // instead of a dead-end; gated by `showMaxOut`, so it hides once there's
      // nothing left to maximize.
      <MaxOutFlowStack>
        {maxOutOption ? (
          <MaxOutBanner maxOut={maxOutOption} placement="aboveShell" />
        ) : null}
        <Step5Confirmation
          onViewPosition={onGoToMyPosition}
          onBackToCrowdfund={onGoToNetwork}
          onClose={handleClose}
          canInvite={hasFreeInviteSlot(inviteSlotSections)}
          onInvite={() => {
            if (inviteSlotSections && inviteSlotSections.length > 0) {
              setStep('invites')
            } else {
              onGoToMyPosition()
            }
          }}
          amount={snap?.amount ?? (inMax ? maxNewCommitUsd : totalNewAmountUsd)}
          estimatedArm={
            snap?.estimatedArm ??
            (inMax
              ? Math.round(maxEstimatedArm)
              : isFullyCommitted
                ? committedArmEstimate
                : estimatedArm)
          }
          isAdditionalCommit={snap?.isAdditionalCommit ?? isAdditionalCommit}
          totalCommittedUsdc={
            snap?.totalCommittedUsdc ??
            (inMax
              ? usdcToNumber(maxPlan!.totalCommittedAfterUsdc)
              : initialCommittedTotal + totalNewAmountUsd)
          }
          maxedOut={snap?.maxedOut ?? (isFullyCommitted && !inMax)}
          txHash={
            (snap?.maxedOut ?? (isFullyCommitted && !inMax))
              ? undefined
              : commitTxHashFromRows(pipeline.state.rows)
          }
          explorerBaseUrl={getExplorerUrl()}
          secondsLeft={secondsLeft}
          maxOut={maxOutOption ?? undefined}
        />
      </MaxOutFlowStack>
    )
  }

  // Build the approve(total) + N×commit(hop, amount) tx list. The approve covers
  // the sum so the user signs one allowance bump even on a multi-hop commit;
  // each non-zero hop gets its own commit. Ordered SEED → HOP-1 → HOP-2 to match
  // Step3Review. The pipeline store runs them sequentially and stops at any
  // failing row.
  const buildSteps = (activeSigner: Signer): TxStep[] => {
    const totalBig = totalNewAmountUsdc
    const steps: TxStep[] = []
    if (needsApproval(totalBig)) {
      steps.push({
        label: `Approve ${formatUsdc(totalBig)} USDC`,
        send: () => {
          const usdc = new Contract(usdcAddress!, ERC20_ABI_FRAGMENTS, activeSigner)
          return submitWrite(usdc, 'approve', [crowdfundAddress!, totalBig], activeSigner)
        },
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
        send: () => {
          const crowdfund = new Contract(crowdfundAddress!, CROWDFUND_ABI_FRAGMENTS, activeSigner)
          return submitWrite(crowdfund, 'commit', [p.hop, amountBig], activeSigner)
        },
        onReceipt: (logs) => onReceiptLogs?.(logs),
      })
    }
    return steps
  }

  // Start (or retry) the pipeline. A defensive guard surfaces an actionable
  // error row instead of dropping into Step4's neutral state with nothing sent.
  const startPipeline = async () => {
    if (!crowdfundAddress || !usdcAddress || (!maxMode && totalNewAmountUsd <= 0)) {
      setAttemptError('Wallet not ready — reconnect and retry.')
      return
    }
    // Prefer the hook-derived signer; when it's missing, resolve one
    // imperatively from the connector. useWalletClient's cached query can stay
    // undefined for an entire session after a fresh connect (wagmi #2784 /
    // #3825) even though the connector is fine — ask it directly at click time.
    let activeSigner: Signer | null = signer
    if (!activeSigner) {
      try {
        activeSigner = await resolveSigner()
      } catch (err) {
        setAttemptError(describeSignerError(err))
        return
      }
    }
    setAttemptError(null)
    if (phase === 'error') {
      pipeline.retry()
      return
    }
    // Max mode: run the bundled approve + multicall (self-invites + commits).
    if (maxMode && maxPlan) {
      if (!walletAddress) {
        setAttemptError('Wallet not ready — reconnect and retry.')
        return
      }
      pipeline.run(buildMaxSteps(activeSigner), {
        onSuccess: () => { void refreshAllowance() },
        // Snapshot the confirmation values so a closed-then-resumed max-out
        // still renders the right summary (local maxMode/maxPlan are lost on
        // remount; the pipeline + this snapshot survive).
        confirmation: maxConfirmation,
      })
      return
    }
    pipeline.run(buildSteps(activeSigner), {
      // Refresh balance + allowance so the navbar badge and any subsequent open
      // see the post-commit numbers and don't skip approval on stale allowance.
      onSuccess: () => {
        void refreshAllowance()
      },
      // Same snapshot for the normal commit path (amounts are local state, lost
      // on a close/reopen across the tx).
      confirmation: {
        amount: totalNewAmountUsd,
        estimatedArm: Math.round(estimatedArm),
        isAdditionalCommit,
        totalCommittedUsdc: initialCommittedTotal + totalNewAmountUsd,
        maxedOut: false,
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
        secondsLeft={secondsLeft}
        hideConnectEyebrow
        onJoin={() => setStep('beforeYouStart')}
        onClose={handleClose}
      />
    )
  }

  if (step === 'beforeYouStart') {
    return (
      <StepBeforeYouStart
        hopVariant={splashHopVariant}
        capUsdc={totalCapUsd}
        inviteCount={freeInviteSlots}
        maxOutCeilingUsdc={maxOutOption?.ceilingUsd}
        // Empty string rather than undefined — the screen falls back to a demo
        // address when it gets neither.
        walletAddress={walletAddress ?? ''}
        walletDisplayAddress={walletAddress ? truncateAddress(walletAddress) : '—'}
        windowClosesLabel={formatWindowCloses(windowEndUnix)}
        contractAddress={crowdfundAddress ?? undefined}
        explorerBaseUrl={getExplorerUrl()}
        onBack={() => setStep('splash')}
        onContinue={() => setStep('commit')}
        onClose={handleClose}
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
    // options render (instead of a dead-end "fully committed" message). When
    // self-fill headroom remains, that confirmation surfaces the Max out banner.
    if (isFullyCommitted) {
      return renderConfirmation()
    }
    // The "commit the maximum" banner is hoisted ABOVE the Step2Commit card
    // (rather than inside it) so it reads as a banner between the modal's close
    // (X) and the card. ParticipateFlowV2's output lands in the modal's `.step`
    // slot, directly under the close button.
    let commitCard: ReactNode = null
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
      commitCard = (
        <Step2Commit
          hopRows={hopRows}
          availableBalance={usdcToNumber(balance)}
          onNext={() => {}}
          onNextMulti={(next) => {
            setAmounts({ 0: next[0] ?? 0, 1: next[1] ?? 0, 2: next[2] ?? 0 })
            setStep('review')
          }}
          showBack={showSplash}
          onBack={() => (showSplash ? setStep('beforeYouStart') : onGoToNetwork())}
          onClose={handleClose}
          maxOut={maxOutOption ?? undefined}
        />
      )
    } else if (primaryPosition) {
      // Single-hop path — identical to pre-multi-hop UX.
      const effectiveCapUsd = usdcToNumber(primaryPosition.effectiveCap)
      const availableBalance = usdcToNumber(balance)
      commitCard = (
        <Step2Commit
          onNext={(amt) => {
            setAmounts({
              0: primaryPosition.hop === 0 ? amt : 0,
              1: primaryPosition.hop === 1 ? amt : 0,
              2: primaryPosition.hop === 2 ? amt : 0,
            })
            setStep('review')
          }}
          showBack={showSplash}
          onBack={() => (showSplash ? setStep('beforeYouStart') : onGoToNetwork())}
          onClose={handleClose}
          maxAmount={effectiveCapUsd}
          availableBalance={availableBalance}
          maxArm={effectiveCapUsd}
          existingCommittedUsdc={initialCommittedByHop[primaryPosition.hop]}
          initialAmount={amounts[primaryPosition.hop]}
          hopLabel={HOP_LABELS[primaryPosition.hop]}
          hopColor={hopPillDotColor(HOP_DOT_KEYS[primaryPosition.hop])}
          maxOut={maxOutOption ?? undefined}
        />
      )
    }
    if (!commitCard) return null
    return (
      <MaxOutFlowStack>
        {maxOutOption ? (
          <MaxOutBanner maxOut={maxOutOption} placement="aboveShell" />
        ) : null}
        {commitCard}
      </MaxOutFlowStack>
    )
  }

  if (step === 'review') {
    // Max mode: review the bundled self-invite + commit plan.
    if (maxMode && maxPlan) {
      const hopCommits: Step3ReviewHopCommit[] = maxPlan.commits.map((c) => ({
        hop: c.hop,
        hopLabel: HOP_LABELS[c.hop],
        hopColor: hopPillDotColor(HOP_DOT_KEYS[c.hop]),
        amount: usdcToNumber(c.amount),
      }))
      const note = (
        <>
          {maxPlan.totalInvites > 0 ? (
            <>
              <strong>Self-invite bundle.</strong> Issues {maxPlan.totalInvites}{' '}
              self-invite{maxPlan.totalInvites === 1 ? '' : 's'} to unlock your full
              ceiling, then commits at every hop — all in one transaction. This spends
              your own invite slots on yourself, so they won't be available to invite
              others.
            </>
          ) : (
            <>
              <strong>Commit the maximum.</strong> Commits your full cap at every hop
              — all in one transaction.
            </>
          )}
          {maxPlan.balanceLimited && (
            <div
              style={{
                marginTop: 'var(--primitives-spacing-2)',
                fontWeight: 'var(--primitives-fontWeight-medium)',
                color: 'var(--semantic-color-status-warning)',
              }}
            >
              Your wallet is short ${usdcToNumber(maxPlan.shortfallUsdc).toLocaleString()} for
              the full bundle — top up to continue.
            </div>
          )}
        </>
      )
      return (
        <Step3Review
          onNext={() => {
            setStep('approve')
            void startPipeline()
          }}
          onBack={() => {
            resetMax()
            setStep('commit')
          }}
          onClose={handleClose}
          disabled={submitting || maxPlan.balanceLimited}
          hopCommits={hopCommits.length > 1 ? hopCommits : undefined}
          hopLevel={hopCommits.length === 1 ? HOP_LABELS[maxPlan.commits[0]!.hop] : undefined}
          amount={maxNewCommitUsd}
          estimatedArm={Math.round(maxEstimatedArm)}
          note={note}
        />
      )
    }
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
            void startPipeline()
          }}
          onBack={() => setStep('commit')}
          onClose={handleClose}
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
          void startPipeline()
        }}
        onBack={() => setStep('commit')}
        onClose={handleClose}
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
        amount={maxMode ? maxNewCommitUsd : totalNewAmountUsd}
        txs={rows.length ? rows : undefined}
        onDone={() => setStep('confirmation')}
        onBack={() => {
          // Return to review with entered amounts preserved (amounts state is
          // untouched). Reset the pipeline so a fresh confirm starts clean.
          pipeline.reset()
          setAttemptError(null)
          setStep('review')
        }}
        onClose={handleClose}
        onRetry={() => {
          // Resume from the failed row (a succeeded approve isn't repeated).
          void startPipeline()
        }}
      />
    )
  }

  if (step === 'invites') {
    if (inviteSlotSections && inviteSlotSections.length > 0) {
      return (
        <ParticipateFlowInviteSlots
          sections={inviteSlotSections}
          selfWalletAddress={walletAddress ?? undefined}
          onDoItLater={onGoToMyPosition}
          onBack={() => setStep('confirmation')}
          onClose={handleClose}
          socials={<FooterSocials />}
        />
      )
    }
    onGoToMyPosition()
    return null
  }

  // step === 'confirmation'
  return renderConfirmation()
}
