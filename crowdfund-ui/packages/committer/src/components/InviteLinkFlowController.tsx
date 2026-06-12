// ABOUTME: Path 1 invite-link flow controller — runs the designer's Connect → Step2Commit → Step3Review → Step4Approve → Step5Confirmation step machine inline within the /invite landing page, wired to real approve + commitWithInvite transactions.
// ABOUTME: Self-contained: pulls wagmi wallet state, deployment, provider, balance, allowance internally so the landing page can mount it with just `inviteData`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { JsonRpcProvider, Contract } from 'ethers'
import {
  ParticipateFlowInviteSlots,
  Step1Connect,
  Step1SwitchNetwork,
  Step2Commit,
  Step3Review,
  Step4Approve,
  Step5Confirmation,
  INVITE_LINK_STEPS,
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
import { getHubRpcUrls, getHubChainId, getHubNetworkLabel, getIndexerUrl, getMaxBlockRange, getPollIntervalMs } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import type { InviteLinkData } from '@/lib/inviteLinks'
import { useWallet } from '@/hooks/useWallet'
import { useBeforeUnloadGuard } from '@/hooks/useBeforeUnloadGuard'
import { useTxPipeline, type TxStep } from '@/hooks/useTxPipeline'
import { useAllowance } from '@/hooks/useAllowance'
import { useEligibility } from '@/hooks/useEligibility'
import { effectiveInviteCapUsdc } from '@/lib/inviteCapMath'
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
    ingestReceiptLogs,
  )

  // The approve+commitWithInvite pipeline lives in the address-keyed store so it
  // survives navigation and can't run twice for one address.
  const pipeline = useTxPipeline(lowerAddress)
  const phase = pipeline.state.phase
  const submitting = phase === 'running' || phase === 'paused'

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
  const buildSteps = (): TxStep[] => {
    const amountBig = numberToUsdc(amount)
    const steps: TxStep[] = []
    if (amountBig > allowance) {
      steps.push({
        label: `Approve ${formatUsdc(amountBig)} USDC`,
        send: () =>
          new Contract(deployment!.contracts.usdc, ERC20_ABI_FRAGMENTS, signer!).approve(
            deployment!.contracts.crowdfund,
            amountBig,
          ),
        // Re-read allowance so a retry's skip-approval decision sees the real value.
        after: allowanceState.refresh,
      })
    }
    steps.push({
      label: `Join & commit ${formatUsdc(amountBig)} at ${hopLabel(targetHop)}`,
      send: () =>
        new Contract(deployment!.contracts.crowdfund, CROWDFUND_ABI_FRAGMENTS, signer!).commitWithInvite(
          inviteData.inviter,
          inviteData.fromHop,
          inviteData.nonce,
          inviteData.deadline,
          inviteData.signature,
          amountBig,
        ),
      // Fast-path the Invited + Committed events into the graph so the user has a
      // recognized hop position the moment we hit Step5.
      onReceipt: (logs) => ingestReceiptLogs(logs),
      // Refresh balance + allowance after the commit consumes the spend cap.
      after: allowanceState.refresh,
    })
    return steps
  }

  // Start (or retry) the pipeline. A defensive guard surfaces an actionable
  // error row instead of dropping into Step4's neutral state with nothing sent.
  const startPipeline = () => {
    if (!signer || !deployment || amount <= 0) {
      setAttemptError('Wallet not ready — reconnect and retry.')
      return
    }
    setAttemptError(null)
    if (phase === 'error') {
      pipeline.retry()
      return
    }
    pipeline.run(buildSteps())
  }

  // ── Step renderers ─────────────────────────────────────────────────────

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
              startPipeline()
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
              startPipeline()
            }}
          />
        )
      }

      case 'confirmation': {
        const estimatedArm = Math.round(estimateArmForAmount(amount))
        return (
          <Step5Confirmation
            steps={MODAL_STEPS}
            stepIndex={4}
            stepsStatus="confirmed"
            amount={amount}
            estimatedArm={estimatedArm}
            showViewPositionButton
            onViewPosition={() => navigate('/?view=myposition')}
            onInvite={() => {
              // Match ParticipateFlowV2: stay in the flow's slot, swap to the
              // invite-slots step. Falls back to navigating to MyPosition only
              // if `useInviteSlots` couldn't derive a live config (e.g. graph
              // state hasn't caught up yet — shouldn't happen since we
              // ingested the commit-with-invite receipt above).
              if (!inviteSlots.empty) {
                transitionTo('invites')
              } else {
                navigate('/?view=myposition')
              }
            }}
          />
        )
      }

      case 'invites':
        return (
          <ParticipateFlowInviteSlots
            sections={inviteSlots.sections}
            onDoItLater={() => navigate('/?view=myposition')}
          />
        )

      default:
        return null
    }
  }

  // The 'invites' step (post-commit invite-slot list) can exceed the
  // 480×500 footprint when the user has many slots. Apply the override
  // classes only for that step so the other steps keep their fixed sizing.
  const isInvitesStep = renderStep === 'invites'
  return (
    <div
      className={[inlineStyles.slot, isInvitesStep && inlineStyles.slotInvites]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className={[inlineStyles.step, isInvitesStep && inlineStyles.stepInvites]
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
