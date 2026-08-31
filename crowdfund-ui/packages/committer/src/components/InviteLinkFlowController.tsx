// ABOUTME: Path 1 invite-link flow controller — runs the designer's Connect → Step2Commit → Step3Review → Step4Approve → Step5Confirmation step machine inline within the /invite landing page, wired to real approve + commitWithInvite transactions.
// ABOUTME: Self-contained: pulls wagmi wallet state, deployment, provider, balance, allowance internally so the landing page can mount it with just `inviteData`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { JsonRpcProvider, Contract, type Signer } from 'ethers'
import {
  ParticipateFlowInviteSlots,
  Step1Connect,
  Step1SwitchNetwork,
  Step2Commit,
  Step3Review,
  Step4Approve,
  Step5Confirmation,
  MaxOutBanner,
  INVITE_LINK_STEPS,
  type Step3ReviewHopCommit,
  type Step4Transaction,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  createProvider,
  formatUsdc,
  formatUsdcPlain,
  hopLabel,
  hopPillDotColor,
  useContractEvents,
  useContractState,
  useGraphState,
  estimateUserArmAllocation,
  HOP_CONFIGS,
  type UserHopPosition,
} from '@armada/crowdfund-shared'
// CSS modules are co-located rather than imported from `@armada/crowdfund-shared`
// because that package's `exports` field doesn't expose internal sub-paths.
// These files are byte-identical to the ones in shared (ported from the
// designer's mockup); promote to shared with a proper subpath export the day
// another consumer needs them.
import inlineStyles from './InviteLinkFlowInline.module.css'
import stepStyles from './InviteLinkFlowStepTransition.module.css'
import { FooterSocials } from '@/components/FooterSocials'
import { getHubRpcUrls, getHubChainId, getHubNetworkLabel, getIndexerUrl, getMaxBlockRange, getPollIntervalMs } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import type { InviteLinkData } from '@/lib/inviteLinks'
import { resolveSigner, describeSignerError } from '@/lib/resolveSigner'
import { submitWrite } from '@/lib/submitWrite'
import { useWallet } from '@/hooks/useWallet'
import { useBeforeUnloadGuard } from '@/hooks/useBeforeUnloadGuard'
import { useTxPipeline, type TxStep } from '@/hooks/useTxPipeline'
import { useResetPipelineOnClose } from '@/hooks/useResetPipelineOnClose'
import { useSelfFill } from '@/hooks/useSelfFill'
import { useAllowance } from '@/hooks/useAllowance'
import { useEligibility } from '@/hooks/useEligibility'
import { effectiveInviteCapUsdc, isAtInviteCap } from '@/lib/inviteCapMath'
import { useInviteLinks } from '@/hooks/useInviteLinks'
import { useInviteSlots } from '@/hooks/useInviteSlots'

type FlowStep = 'wallet' | 'commit' | 'review' | 'approve' | 'confirmation' | 'invites'

const MODAL_STEPS = [...INVITE_LINK_STEPS]
const STEP_TRANSITION_MS = 240

export interface InviteLinkFlowControllerProps {
  inviteData: InviteLinkData
}

// Convert a bigint USDC amount (6 decimals) into a plain number for the
// designer's step components. Same helper as ParticipateFlowV2 — both flows
// thread USDC bigints into number-typed step props.
function usdcToNumber(amount: bigint): number {
  return Number(formatUsdcPlain(amount))
}

function numberToUsdc(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000))
}

// ARM (18 decimals) bigint → plain number, splitting whole/frac to avoid
// precision loss past Number.MAX_SAFE_INTEGER. Mirrors ParticipateFlowV2.
function armToNumber(amount: bigint): number {
  const whole = amount / 10n ** 18n
  const frac = amount % 10n ** 18n
  return Number(whole) + Number(frac) / 1e18
}

export function InviteLinkFlowController({ inviteData }: InviteLinkFlowControllerProps) {
  const navigate = useNavigate()
  // Wallet state via the shared hook (connection, signer, wrong-network
  // detection, and one-click chain switch). A wallet on the wrong chain is NOT
  // "connected" for flow purposes — otherwise we'd advance to commit and build
  // a signer against the wrong network. The wallet step renders a
  // switch-network prompt instead.
  const wallet = useWallet()
  const { signer } = wallet
  const walletConnected = wallet.connected
  const wrongChain = wallet.isWrongNetwork
  const lowerAddress = wallet.address

  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)

  // Balance + allowance via the shared hook so this flow inherits the same
  // polling cadence + post-tx refresh API the main App uses. Without this,
  // the inline `Step2Commit` Available line and the skip-approve decision
  // would freeze at first-load values and miss any USDC activity that happens
  // on other tabs or after we just consumed the previous allowance.
  const allowanceState = useAllowance(
    lowerAddress,
    deployment?.contracts.usdc ?? null,
    deployment?.contracts.crowdfund ?? null,
    deployment?.contracts.armToken ?? null,
    provider,
    getPollIntervalMs(),
  )
  const { balance, allowance } = allowanceState

  // Data layer for the post-commit `'invites'` step. The /invite route lives
  // outside the main App tree (Jotai atoms are shared, but `useContractEvents`
  // and friends aren't mounted by InviteLandingPage), so wire the same hook
  // chain here so `useInviteSlots` can produce a live `CrowdfundInviteSlotConfig`
  // for the post-commit invite-slots screen. Block timestamp falls back to
  // local time — close enough for the link-expiry checks `useInviteLinks`
  // performs (deadlines are multi-day windows).
  const { events, ingestReceiptLogs } = useContractEvents({
    provider,
    contractAddress: deployment?.contracts.crowdfund ?? null,
    pollIntervalMs: getPollIntervalMs(),
    startBlock: deployment?.deployBlock,
    // Same chainId the main App passes so the /invite page and the main app
    // share one IndexedDB cache namespace instead of clearing each other's.
    chainId: getHubChainId(),
    maxBlockRange: getMaxBlockRange(),
    indexerBaseUrl: getIndexerUrl(),
  })
  const { nodes } = useGraphState()
  const eligibility = useEligibility(lowerAddress, nodes)
  const localBlockTimestamp = useMemo(() => Math.floor(Date.now() / 1000), [events])
  const inviteLinks = useInviteLinks(
    lowerAddress,
    signer,
    deployment?.contracts.crowdfund ?? null,
    localBlockTimestamp,
    events,
  )
  const inviteSlots = useInviteSlots(
    eligibility.positions,
    inviteLinks,
    provider,
    signer,
    deployment?.contracts.crowdfund ?? null,
    lowerAddress,
    events,
    wallet.isWrongNetwork,
    wallet.switchNetwork,
    ingestReceiptLogs,
  )

  // The approve+commitWithInvite pipeline lives in the address-keyed store so it
  // survives navigation and can't run twice for one address.
  const pipeline = useTxPipeline(lowerAddress)
  const phase = pipeline.state.phase
  const submitting = phase === 'running' || phase === 'paused'
  // Clear a finished pipeline when the /invite flow closes, so returning to the
  // crowdfund page starts a fresh commit instead of re-attaching to the stale
  // confirmation. (This flow isn't keyed by address, so the hook's ref handling
  // is what makes the reset target the connected address.)
  useResetPipelineOnClose(pipeline)

  // Step machine + transition state (mirrors the designer's
  // ParticipateFlowInviteLink — fading wraps each step swap). Re-attach: a live
  // pipeline lands directly on the tx surface.
  const [step, setStep] = useState<FlowStep>(
    phase === 'success' ? 'confirmation' : submitting ? 'approve' : walletConnected ? 'commit' : 'wallet',
  )
  const [renderStep, setRenderStep] = useState<FlowStep>(step)
  const [fading, setFading] = useState(false)
  const [amount, setAmount] = useState(0)
  // Defensive guard error when the user confirms with no signer/deployment/amount.
  const [attemptError, setAttemptError] = useState<string | null>(null)
  // Warn before a refresh/tab-close drops the user while a commit is broadcasting.
  useBeforeUnloadGuard(submitting)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const targetHop = inviteData.fromHop + 1
  const hopCap = targetHop <= 2 ? HOP_CONFIGS[targetHop as 0 | 1 | 2].capUsdc : 0n

  // Sale state for the pro-rata ARM estimate (mirrors ParticipateFlowV2's Step3).
  const contractState = useContractState(
    provider,
    deployment?.contracts.crowdfund ?? null,
    getPollIntervalMs(),
  )

  // The redeemer's existing position at the target hop (a re-invited user has
  // one; a first-time invitee doesn't). Redeeming this invite bumps their
  // invitesReceived to (current + 1), which scales the cap — so the input must
  // not be clamped to the 1× HOP_CONFIGS cap.
  const targetPosition = useMemo(
    () => eligibility.positions.find((p) => p.hop === targetHop) ?? null,
    [eligibility.positions, targetHop],
  )
  const existingInvitesReceived = targetPosition?.invitesReceived ?? 0
  const existingCommittedUsdc = targetPosition?.committed ?? 0n
  const effectiveCapUsdc = effectiveInviteCapUsdc(existingInvitesReceived, hopCap)
  // Already at the (post-redemption) cap with no room left to commit. Skip the
  // input step and land on the confirmation screen with "fully committed" copy,
  // matching the participate modal, instead of a dead-end input message.
  const isFullyCommitted = existingCommittedUsdc > 0n && existingCommittedUsdc >= effectiveCapUsdc
  // Every commitWithInvite stacks another invite onto the invitee, which the
  // contract rejects once they're at the hop's `maxInvitesReceived`. Detect that
  // up front so an already-maxed re-invitee is blocked before signing a useless
  // approve, rather than hitting a revert after it. A first-time invitee (0
  // received) is never at the cap.
  const maxInvitesReceived =
    targetHop <= 2 ? HOP_CONFIGS[targetHop as 0 | 1 | 2].maxInvitesReceived : 0
  const atInviteCap = isAtInviteCap(existingInvitesReceived, maxInvitesReceived)

  // Pro-rata ARM for a given new USD commit at the target hop — same math as
  // ParticipateFlowV2's Step3, so all /invite screens show one consistent number.
  const estimateArmForAmount = useCallback(
    (newAmountUsd: number): number => {
      if (newAmountUsd <= 0) return 0
      const newBig = numberToUsdc(newAmountUsd)
      const projected: UserHopPosition[] = [
        {
          hop: targetHop,
          committed: existingCommittedUsdc + newBig,
          effectiveCap: effectiveCapUsdc,
        },
      ]
      const alloc = estimateUserArmAllocation(
        projected,
        contractState.hopStats,
        contractState.cappedDemand + newBig,
        contractState.saleSize,
      )
      return armToNumber(alloc)
    },
    [targetHop, existingCommittedUsdc, effectiveCapUsdc, contractState.hopStats, contractState.cappedDemand, contractState.saleSize],
  )

  // ARM reserved for the redeemer's existing committed position (no new commit)
  // — shown on the "already fully committed" confirmation, where
  // `estimateArmForAmount(0)` is 0 (no new amount).
  const committedArmEstimate = useMemo(() => {
    if (existingCommittedUsdc <= 0n) return 0
    const projected: UserHopPosition[] = [
      { hop: targetHop, committed: existingCommittedUsdc, effectiveCap: effectiveCapUsdc },
    ]
    return armToNumber(
      estimateUserArmAllocation(
        projected,
        contractState.hopStats,
        contractState.cappedDemand,
        contractState.saleSize,
      ),
    )
  }, [targetHop, existingCommittedUsdc, effectiveCapUsdc, contractState.hopStats, contractState.cappedDemand, contractState.saleSize])

  // Load deployment + JSON-RPC provider for balance/allowance + tx submission.
  // The failure is surfaced (deployError) with a Retry rather than swallowed —
  // otherwise the invitee steps through Commit/Review against a null deployment
  // and lands in a no-op pipeline.
  const loadDeploymentData = useCallback(() => {
    setDeployError(null)
    loadDeployment()
      .then((d) => {
        setDeployment(d)
        // One shared fallback provider for the whole page (events poll, allowance,
        // and tx submission) instead of a single-URL provider that dies when the
        // primary RPC is down.
        setProvider(createProvider(getHubRpcUrls()))
      })
      .catch((err) => {
        setDeployError(
          err instanceof Error ? err.message : 'Could not load the crowdfund deployment.',
        )
      })
  }, [])

  useEffect(() => {
    loadDeploymentData()
  }, [loadDeploymentData])

  // Auto-advance past the wallet step once the user connects (matches the
  // ParticipateFlowV2 pattern). Going back to disconnected drops to wallet.
  useEffect(() => {
    if (walletConnected && step === 'wallet') transitionTo('commit')
    if (!walletConnected && step !== 'wallet') transitionTo('wallet')
    // `transitionTo` is stable across renders — see useCallback below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletConnected, step])

  const clearTransitionTimer = () => {
    if (transitionTimer.current) {
      clearTimeout(transitionTimer.current)
      transitionTimer.current = null
    }
  }

  const transitionTo = useCallback((next: FlowStep) => {
    clearTransitionTimer()
    setFading(true)
    transitionTimer.current = setTimeout(() => {
      setStep(next)
      setRenderStep(next)
      setFading(false)
      transitionTimer.current = null
    }, STEP_TRANSITION_MS)
  }, [])

  useEffect(() => () => clearTransitionTimer(), [])

  // Advance to confirmation once the pipeline completes — works even if it
  // finished after the user navigated away and back (re-attach reads `success`).
  useEffect(() => {
    if (phase !== 'success' || step !== 'approve') return
    const t = setTimeout(() => transitionTo('confirmation'), 600)
    return () => clearTimeout(t)
  }, [phase, step, transitionTo])

  // A wallet rejection returns the flow to review (quiet — no red error row).
  useEffect(() => {
    if (phase !== 'rejected') return
    transitionTo('review')
    pipeline.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, transitionTo])

  // Build the approve(amount)? + commitWithInvite tx list. The store runs them
  // sequentially and stops at any failing row. Mirrors ParticipateFlowV2 but
  // with the inviter signature args on the commit call.
  const buildSteps = (activeSigner: Signer): TxStep[] => {
    const amountBig = numberToUsdc(amount)
    const steps: TxStep[] = []
    if (amountBig > allowance) {
      steps.push({
        label: `Approve ${formatUsdc(amountBig)} USDC`,
        send: () => {
          const usdc = new Contract(deployment!.contracts.usdc, ERC20_ABI_FRAGMENTS, activeSigner)
          return submitWrite(usdc, 'approve', [deployment!.contracts.crowdfund, amountBig], activeSigner)
        },
        // Re-read allowance so a retry's skip-approval decision sees the real value.
        after: allowanceState.refresh,
      })
    }
    steps.push({
      label: `Join & commit ${formatUsdc(amountBig)} at ${hopLabel(targetHop)}`,
      send: () => {
        const crowdfund = new Contract(
          deployment!.contracts.crowdfund,
          CROWDFUND_ABI_FRAGMENTS,
          activeSigner,
        )
        const commitArgs = [
          inviteData.inviter,
          inviteData.fromHop,
          inviteData.nonce,
          inviteData.deadline,
          inviteData.signature,
          amountBig,
        ] as const
        return submitWrite(crowdfund, 'commitWithInvite', commitArgs, activeSigner)
      },
      // Fast-path the Invited + Committed events into the graph so the user has a
      // recognized hop position the moment we hit Step5.
      onReceipt: (logs) => ingestReceiptLogs(logs),
      // Refresh balance + allowance after the commit consumes the spend cap.
      after: allowanceState.refresh,
    })
    return steps
  }

  // Self-fill ("max out") — offered on the confirmation once the link is
  // redeemed. By then the invitee is a whitelisted hop participant, so the
  // shared controller's plain invite+commit bundle applies (no commitWithInvite
  // in the bundle). Only the SEED→HOP-1 case has downward headroom; the hook's
  // `showMaxOut` gate handles the rest.
  const windowOpen =
    contractState.armLoaded &&
    contractState.blockTimestamp >= contractState.windowStart &&
    contractState.blockTimestamp <= contractState.windowEnd
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
    positions: eligibility.positions,
    balance,
    provider,
    walletAddress: lowerAddress,
    crowdfundAddress: deployment?.contracts.crowdfund ?? null,
    usdcAddress: deployment?.contracts.usdc ?? null,
    hopStats: contractState.hopStats,
    cappedDemand: contractState.cappedDemand,
    saleSize: contractState.saleSize,
    needsApproval: allowanceState.needsApproval,
    refreshAllowance: allowanceState.refresh,
    onReceiptLogs: ingestReceiptLogs,
    windowOpen,
    isAdditionalCommit: true,
    onActivated: () => transitionTo('review'),
  })

  // Start (or retry) the pipeline. A defensive guard surfaces an actionable
  // error row instead of dropping into Step4's neutral state with nothing sent.
  const startPipeline = async () => {
    // Distinguish the blockers so the error is actionable (and tells us which
    // one actually fired) rather than a lumped "wallet not ready". Max mode runs
    // the prebuilt bundle and doesn't use the redemption `amount`.
    if (!maxMode && amount <= 0) {
      setAttemptError('Enter an amount to commit.')
      return
    }
    if (!deployment) {
      setAttemptError('Still loading the crowdfund — try again in a moment.')
      return
    }
    // Prefer the hook-derived signer; when it's missing, resolve one
    // imperatively from the connector. useWalletClient's cached query can stay
    // undefined for an entire session after a fresh connect (wagmi #2784 /
    // #3825), which left this button dead with "wallet not ready" — the
    // connector itself is fine, so ask it directly at click time.
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
    // Max mode: run the bundled self-invite + commit (the link was already
    // redeemed, so this is plain invite/commit — no commitWithInvite).
    if (maxMode && maxPlan) {
      pipeline.run(buildMaxSteps(activeSigner), { confirmation: maxConfirmation })
      return
    }
    pipeline.run(buildSteps(activeSigner), {
      // Snapshot the confirmation values so a closed-then-resumed redemption
      // still renders the right summary (the local `amount` state is lost on
      // remount; the pipeline + this snapshot survive). This is a first commit
      // at the target hop, so it is never an "additional" commit.
      confirmation: {
        amount,
        estimatedArm: Math.round(estimateArmForAmount(amount)),
        isAdditionalCommit: false,
        totalCommittedUsdc: amount,
        maxedOut: false,
      },
    })
  }

  // ── Step renderers ─────────────────────────────────────────────────────

  // The confirmation screen, shared by the normal post-commit path and the
  // "already fully committed" shortcut. `maxedOut` swaps in the no-new-commit
  // copy and shows the ARM reserved for the existing position.
  const renderConfirmation = (maxedOut: boolean) => {
    // On the post-commit path, prefer the snapshot captured at run() time — it
    // survives a close/reopen across the tx, where the local `amount` does not.
    // The maxed-out shortcut never runs a pipeline, so it always uses live state.
    const snap = maxedOut ? undefined : pipeline.state.confirmation
    return (
      // Banner hoisted above the card, consistent with the commit flow. By this
      // step the link is redeemed, so "Max out" offers to extend the invitee's
      // ceiling (self-invite + commit) when headroom remains.
      <div style={{ width: '100%' }}>
        {maxOutOption && <MaxOutBanner maxOut={maxOutOption} />}
        <Step5Confirmation
          steps={MODAL_STEPS}
          stepIndex={4}
          stepsStatus="confirmed"
          amount={maxedOut ? 0 : snap?.amount ?? amount}
          estimatedArm={
            maxedOut ? committedArmEstimate : snap?.estimatedArm ?? Math.round(estimateArmForAmount(amount))
          }
          totalCommittedUsdc={maxedOut ? usdcToNumber(existingCommittedUsdc) : undefined}
          maxedOut={maxedOut}
          showViewPositionButton
          onViewPosition={() => navigate('/?view=myposition')}
          onInvite={() => {
            // Match ParticipateFlowV2: stay in the flow's slot, swap to the
            // invite-slots step. Falls back to navigating to MyPosition only if
            // `useInviteSlots` couldn't derive a live config.
            if (!inviteSlots.empty) {
              transitionTo('invites')
            } else {
              navigate('/?view=myposition')
            }
          }}
        />
      </div>
    )
  }

  const renderCurrentStep = () => {
    if (deployError) {
      return (
        <div className="space-y-3 p-6 text-center">
          <h2 className="text-destructive text-lg font-semibold">Couldn't load the crowdfund</h2>
          <p className="text-muted-foreground text-sm">{deployError}</p>
          <button
            type="button"
            onClick={loadDeploymentData}
            className="rounded-full border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Retry
          </button>
        </div>
      )
    }
    // Don't let the user act on commit/review/approve until the deployment is
    // loaded (the wallet step needs no deployment, so it stays available).
    if (renderStep !== 'wallet' && !deployment) {
      return <div className="text-muted-foreground p-6 text-center">Loading…</div>
    }
    switch (renderStep) {
      case 'wallet':
        if (wrongChain) {
          return (
            <Step1SwitchNetwork
              showSteps
              networkLabel={getHubNetworkLabel()}
              onSwitch={() => wallet.switchNetwork()}
            />
          )
        }
        return (
          <Step1Connect
            showSteps
            onConnect={() => wallet.connect()}
          />
        )

      case 'commit': {
        // At the invite-stacking cap for this hop — redeeming would revert
        // ("max invites received"), since commitWithInvite stacks another invite.
        // Block before the approve so no gas is wasted; the invitee can still
        // commit to their existing position via the normal flow.
        if (atInviteCap) {
          const hasHeadroom = existingCommittedUsdc < effectiveCapUsdc
          return (
            <div className="space-y-4 p-6 text-center">
              <h2 className="text-lg font-semibold">Invite limit reached</h2>
              <p className="text-muted-foreground text-sm">
                You've already accepted the maximum number of invites at {hopLabel(targetHop)}, so
                this invite link can't be redeemed.
                {hasHeadroom
                  ? ' You can still commit to your existing position from My Position.'
                  : ''}
              </p>
              <div className="flex justify-center gap-3">
                <button
                  type="button"
                  onClick={() => navigate('/?view=myposition')}
                  className="rounded-full border border-border px-4 py-2 text-sm hover:bg-muted"
                >
                  View my position
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="rounded-full border border-border px-4 py-2 text-sm hover:bg-muted"
                >
                  Back to crowdfund
                </button>
              </div>
            </div>
          )
        }
        // No room left to commit — skip straight to the confirmation screen
        // (stepper, What's next, Invite) instead of a dead-end input message.
        if (isFullyCommitted) {
          return renderConfirmation(true)
        }
        // Cap scales with invitesReceived (stacked re-invites are part of the
        // launch motion), so use the effective cap, not the 1× HOP_CONFIGS cap.
        const maxAmount = usdcToNumber(effectiveCapUsdc)
        const existingCommitted = usdcToNumber(existingCommittedUsdc)
        const remaining = Math.max(0, maxAmount - existingCommitted)
        const availableBalance = usdcToNumber(balance)
        return (
          <Step2Commit
            steps={MODAL_STEPS}
            stepIndex={2}
            onNext={(nextAmount) => {
              setAmount(nextAmount)
              transitionTo('review')
            }}
            onBack={() => transitionTo('wallet')}
            maxAmount={maxAmount}
            existingCommittedUsdc={existingCommitted}
            availableBalance={availableBalance}
            maxArm={Math.round(estimateArmForAmount(remaining))}
            estimateArm={estimateArmForAmount}
            hopLabel={hopLabel(targetHop)}
            hopColor={hopPillDotColor(targetHop === 2 ? 'hop-2' : 'hop-1')}
          />
        )
      }

      case 'review': {
        // Max mode: review the bundled self-invite + commit plan.
        if (maxMode && maxPlan) {
          const hopCommits: Step3ReviewHopCommit[] = maxPlan.commits.map((c) => ({
            hop: c.hop,
            hopLabel: hopLabel(c.hop),
            hopColor: hopPillDotColor(c.hop === 0 ? 'seed' : c.hop === 1 ? 'hop-1' : 'hop-2'),
            amount: usdcToNumber(c.amount),
          }))
          const note = (
            <>
              <strong>Self-invite bundle.</strong> Issues {maxPlan.totalInvites}{' '}
              self-invite{maxPlan.totalInvites === 1 ? '' : 's'} to unlock your full
              ceiling, then commits at every hop — all in one transaction. This spends
              your own invite slots on yourself, so they won't be available to invite
              others.
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
              steps={MODAL_STEPS}
              stepIndex={3}
              disabled={submitting || maxPlan.balanceLimited}
              hopCommits={hopCommits.length > 1 ? hopCommits : undefined}
              hopLevel={hopCommits.length === 1 ? hopLabel(maxPlan.commits[0]!.hop) : undefined}
              amount={maxNewCommitUsd}
              estimatedArm={Math.round(maxEstimatedArm)}
              note={note}
              onBack={() => {
                resetMax()
                transitionTo('confirmation')
              }}
              onNext={() => {
                transitionTo('approve')
                void startPipeline()
              }}
            />
          )
        }
        const estimatedArm = Math.round(estimateArmForAmount(amount))
        return (
          <Step3Review
            steps={MODAL_STEPS}
            stepIndex={3}
            hopLevel={hopLabel(targetHop)}
            amount={amount}
            estimatedArm={estimatedArm}
            disabled={submitting}
            onBack={() => transitionTo('commit')}
            onNext={() => {
              transitionTo('approve')
              void startPipeline()
            }}
          />
        )
      }

      case 'approve': {
        // Guard error renders as a standalone row; otherwise rows come live from
        // the pipeline store.
        const rows: Step4Transaction[] = attemptError
          ? [{ label: 'Join & commit', status: 'error', errorMessage: attemptError }]
          : pipeline.state.rows
        return (
          <Step4Approve
            steps={MODAL_STEPS}
            stepIndex={4}
            amount={amount}
            txs={rows.length ? rows : undefined}
            onDone={() => transitionTo('confirmation')}
            onBack={() => {
              // Back to review preserves the entered amount; also the only escape
              // on the /invite page (no close button). Reset so a fresh confirm
              // starts clean.
              pipeline.reset()
              setAttemptError(null)
              transitionTo('review')
            }}
            onRetry={() => {
              void startPipeline()
            }}
          />
        )
      }

      case 'confirmation':
        return renderConfirmation(false)

      case 'invites':
        return (
          <ParticipateFlowInviteSlots
            sections={inviteSlots.sections}
            onDoItLater={() => navigate('/?view=myposition')}
            socials={<FooterSocials />}
          />
        )

      default:
        return null
    }
  }

  // Steps that can exceed the fixed 480×500 footprint opt into a grow + scroll
  // override so `.step`'s overflow: hidden doesn't clip their content: the
  // post-commit 'invites' slot list (many slots), and the 'confirmation' step
  // once the Max out banner is hoisted above the 500px card.
  const isInvitesStep = renderStep === 'invites'
  const isExpandedStep = isInvitesStep || (renderStep === 'confirmation' && !!maxOutOption)
  return (
    <div
      className={[inlineStyles.slot, isExpandedStep && inlineStyles.slotInvites]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className={[inlineStyles.step, isExpandedStep && inlineStyles.stepInvites]
          .filter(Boolean)
          .join(' ')}
      >
        <div
          key={renderStep}
          className={[
            stepStyles.frame,
            fading ? stepStyles.frameExit : stepStyles.frameEnter,
          ].join(' ')}
        >
          {renderCurrentStep()}
        </div>
      </div>
    </div>
  )
}
