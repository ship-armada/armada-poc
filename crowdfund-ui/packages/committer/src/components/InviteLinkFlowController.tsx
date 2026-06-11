// ABOUTME: Path 1 invite-link flow controller — runs the designer's Connect → Step2Commit → Step3Review → Step4Approve → Step5Confirmation step machine inline within the /invite landing page, wired to real approve + commitWithInvite transactions.
// ABOUTME: Self-contained: pulls wagmi wallet state, deployment, provider, balance, allowance internally so the landing page can mount it with just `inviteData`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { JsonRpcProvider, Contract, type TransactionResponse } from 'ethers'
import { useAccount, useChainId, useWalletClient } from 'wagmi'
import { useConnectModal, useChainModal } from '@rainbow-me/rainbowkit'
import {
  ParticipateFlowInviteSlots,
  Step1Connect,
  Step1SwitchNetwork,
  Step2Commit,
  Step3Review,
  Step4Approve,
  Step5Confirmation,
  INVITE_LINK_STEPS,
  type ReceiptLogLike,
  type Step4Transaction,
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  createProvider,
  formatUsdc,
  formatUsdcPlain,
  hopLabel,
  hopPillDotColor,
  useContractEvents,
  useGraphState,
  HOP_CONFIGS,
} from '@armada/crowdfund-shared'
// CSS modules are co-located rather than imported from `@armada/crowdfund-shared`
// because that package's `exports` field doesn't expose internal sub-paths.
// These files are byte-identical to the ones in shared (ported from the
// designer's mockup); promote to shared with a proper subpath export the day
// another consumer needs them.
import inlineStyles from './InviteLinkFlowInline.module.css'
import stepStyles from './InviteLinkFlowStepTransition.module.css'
import { walletClientToSigner } from '@/lib/wagmiAdapter'
import { mapRevertToMessage } from '@/lib/revertMessages'
import { TX_WAIT_TIMEOUT_MS, TX_PENDING_MESSAGE, isTxTimeoutError } from '@/lib/txWait'
import { getHubRpcUrls, getHubChainId, getHubNetworkLabel, getIndexerUrl, getMaxBlockRange, getPollIntervalMs } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import type { CrowdfundDeployment } from '@/config/deployments'
import type { InviteLinkData } from '@/lib/inviteLinks'
import { useAllowance } from '@/hooks/useAllowance'
import { useEligibility } from '@/hooks/useEligibility'
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

export function InviteLinkFlowController({ inviteData }: InviteLinkFlowControllerProps) {
  const navigate = useNavigate()
  const { address: rawAddress } = useAccount()
  const activeChainId = useChainId()
  const { data: walletClient } = useWalletClient()
  const { openConnectModal } = useConnectModal()
  const { openChainModal } = useChainModal()

  // Chain-aware: a wallet on the wrong chain is NOT "connected" for flow
  // purposes — otherwise we'd advance to commit and build a signer against the
  // wrong network. The wallet step renders a switch-network prompt instead.
  const isConnected = Boolean(rawAddress)
  const wrongChain = isConnected && activeChainId !== getHubChainId()
  const walletConnected = isConnected && !wrongChain
  const signer = useMemo(() => {
    if (!walletClient || wrongChain) return null
    try { return walletClientToSigner(walletClient) } catch { return null }
  }, [walletClient, wrongChain])

  const [deployment, setDeployment] = useState<CrowdfundDeployment | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [provider, setProvider] = useState<JsonRpcProvider | null>(null)

  // Balance + allowance via the shared hook so this flow inherits the same
  // polling cadence + post-tx refresh API the main App uses. Without this,
  // the inline `Step2Commit` Available line and the skip-approve decision
  // would freeze at first-load values and miss any USDC activity that happens
  // on other tabs or after we just consumed the previous allowance.
  const allowanceState = useAllowance(
    rawAddress ? rawAddress.toLowerCase() : null,
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
  const lowerAddress = rawAddress ? rawAddress.toLowerCase() : null
  const eligibility = useEligibility(lowerAddress, nodes)
  const localBlockTimestamp = useMemo(() => Math.floor(Date.now() / 1000), [events])
  const inviteLinks = useInviteLinks(
    lowerAddress,
    signer,
    deployment?.contracts.crowdfund ?? null,
    localBlockTimestamp,
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

  // Step machine + transition state (mirrors the designer's
  // ParticipateFlowInviteLink — fading wraps each step swap).
  const [step, setStep] = useState<FlowStep>(walletConnected ? 'commit' : 'wallet')
  const [renderStep, setRenderStep] = useState<FlowStep>(step)
  const [fading, setFading] = useState(false)
  const [amount, setAmount] = useState(0)
  const [txs, setTxs] = useState<Step4Transaction[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Synchronous re-entrancy guard — blocks a double-click re-running the pipeline.
  const runningRef = useRef(false)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const targetHop = inviteData.fromHop + 1
  const hopCap = targetHop <= 2 ? HOP_CONFIGS[targetHop as 0 | 1 | 2].capUsdc : 0n

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

  // Tx pipeline — runs `approve` (if needed) then `commitWithInvite`. Updates
  // `txs` so Step4Approve renders the controlled animation while the wallet
  // confirms each transaction. Mirrors the Path 2 pipeline in
  // ParticipateFlowV2 but with the inviter signature args on the commit call.
  const runPipeline = async () => {
    if (runningRef.current) return
    if (!signer || !deployment || amount <= 0) {
      // Surface an actionable error row rather than dropping into Step4's
      // neutral state with no transaction sent.
      setTxs([
        {
          label: 'Join & commit',
          status: 'error',
          errorMessage: 'Wallet not ready — reconnect and retry.',
        },
      ])
      return
    }
    runningRef.current = true
    setSubmitting(true)
    // Reset the in-flight guard on every exit so Retry can re-run.
    const finish = () => {
      runningRef.current = false
      setSubmitting(false)
    }
    const amountBig = numberToUsdc(amount)
    const approveLabel = `Approve ${formatUsdc(amountBig)} USDC`
    const commitLabel = `Join & commit ${formatUsdc(amountBig)} at ${hopLabel(targetHop)}`

    const skipApproval = amountBig <= allowance
    const initial: Step4Transaction[] = skipApproval
      ? [{ label: commitLabel, status: 'loading' }]
      : [
          { label: approveLabel, status: 'loading' },
          { label: commitLabel, status: 'pending' },
        ]
    setTxs(initial)

    const setRowStatus = (index: number, patch: Partial<Step4Transaction>) => {
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
        // ethers v6 receipt.logs is structurally compatible with
        // `ReceiptLogLike`; the `index` vs `logIndex` field name differs.
        onSuccess?.(receipt.logs as unknown as readonly ReceiptLogLike[])
        return true
      } catch (err) {
        if (isTxTimeoutError(err)) {
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

    let cursor = 0
    if (!skipApproval) {
      const ok = await sendAndWait(cursor, approveLabel, async () => {
        const usdc = new Contract(deployment.contracts.usdc, ERC20_ABI_FRAGMENTS, signer)
        return usdc.approve(deployment.contracts.crowdfund, amountBig)
      })
      if (!ok) { finish(); return }
      // Re-read from chain so the next step's `skipApproval` decision (and
      // any subsequent attempt) sees the real allowance, not an optimistic guess.
      await allowanceState.refresh()
      cursor += 1
    }

    const commitOk = await sendAndWait(
      cursor,
      commitLabel,
      async () => {
        const crowdfund = new Contract(deployment.contracts.crowdfund, CROWDFUND_ABI_FRAGMENTS, signer)
        return crowdfund.commitWithInvite(
          inviteData.inviter,
          inviteData.fromHop,
          inviteData.nonce,
          inviteData.deadline,
          inviteData.signature,
          amountBig,
        )
      },
      // Fast-path the Invited + Committed events into the graph so the user
      // has a recognized hop position the moment we hit Step5 — without this,
      // `useEligibility` doesn't see the position until the next event poll
      // and the post-commit invite-slots step wouldn't have a config.
      (logs) => ingestReceiptLogs(logs),
    )
    if (!commitOk) { finish(); return }

    // Refresh balance + allowance after the commit consumes the spend cap so
    // the navbar wallet badge and any subsequent action see the post-tx state
    // immediately, not on the next poll tick.
    await allowanceState.refresh()

    finish()
    setTimeout(() => transitionTo('confirmation'), 600)
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
              onSwitch={() => openChainModal?.()}
            />
          )
        }
        return (
          <Step1Connect
            showSteps
            onConnect={() => openConnectModal?.()}
          />
        )

      case 'commit': {
        const maxAmount = usdcToNumber(hopCap)
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
            availableBalance={availableBalance}
            maxArm={maxAmount}
            hopLabel={hopLabel(targetHop)}
            hopColor={hopPillDotColor(targetHop === 2 ? 'hop-2' : 'hop-1')}
          />
        )
      }

      case 'review': {
        const estimatedArm = Math.round(amount)
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
              setTxs(null)
              transitionTo('approve')
              void runPipeline()
            }}
          />
        )
      }

      case 'approve':
        return (
          <Step4Approve
            steps={MODAL_STEPS}
            stepIndex={4}
            amount={amount}
            txs={txs ?? undefined}
            onDone={() => transitionTo('confirmation')}
            onBack={() => {
              // Back to review preserves the entered amount; also the only escape
              // on the /invite page (no close button).
              setTxs(null)
              transitionTo('review')
            }}
            onRetry={() => {
              setTxs(null)
              void runPipeline()
            }}
          />
        )

      case 'confirmation': {
        const estimatedArm = Math.round(amount)
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
