// ABOUTME: Shared "max out" self-fill controller logic — preview plan, banner option, fresh-read activation, and bundled-pipeline helpers.
// ABOUTME: Consumed by ParticipateFlowV2 (commit modal) and InviteLinkFlowController (/invite) so the two flows can't drift.

import { useMemo, useState } from 'react'
import { type Signer, type JsonRpcProvider } from 'ethers'
import {
  computeSelfFillPlan,
  fetchSelfFillState,
  estimateUserArmAllocation,
  formatUsdcPlain,
  HOP_CONFIGS,
  type SelfFillPlan,
  type SelfFillState,
  type SelfFillHopState,
  type Step2MaxOutOption,
  type ReceiptLogLike,
  type HopStatsData,
  type UserHopPosition,
} from '@armada/crowdfund-shared'
import { buildSelfFillSteps } from '@/lib/selfFillSteps'
import type { TxStep, PipelineConfirmation } from '@/hooks/useTxPipeline'
import type { HopPosition } from '@/hooks/useEligibility'

function usdcToNumber(amount: bigint): number {
  return Number(formatUsdcPlain(amount))
}

function armToNumber(amount: bigint): number {
  const whole = amount / 10n ** 18n
  const frac = amount % 10n ** 18n
  return Number(whole) + Number(frac) / 1e18
}

// Build a SelfFillState snapshot from the event-derived eligibility positions
// for the instant preview (banner headline). Remaining outgoing invites are
// recomputed as `invitesReceived * maxInvites - invitesUsed` (the contract's
// formula) rather than read from the graph's `invitesAvailable`, which doesn't
// re-scale when a later invite raises `invitesReceived`. The executed bundle is
// always recomputed from a fresh on-chain read in `activateMaxOut`.
function positionsToSelfFillState(positions: HopPosition[]): SelfFillState {
  const mk = (hop: number): SelfFillHopState => {
    const p = positions.find((q) => q.hop === hop)
    if (!p) return { invitesReceived: 0, invitesRemaining: 0, committed: 0n }
    const maxInvites = hop < HOP_CONFIGS.length ? HOP_CONFIGS[hop].maxInvites : 0
    const budget = p.invitesReceived * maxInvites
    return {
      invitesReceived: p.invitesReceived,
      invitesRemaining: Math.max(0, budget - p.invitesUsed),
      committed: p.committed,
    }
  }
  return [mk(0), mk(1), mk(2)]
}

export interface UseSelfFillParams {
  /** Event-derived eligibility positions — drive the instant preview. */
  positions: HopPosition[]
  balance: bigint
  /** Read provider for the fresh on-chain plan read. */
  provider?: JsonRpcProvider | null
  walletAddress: string | null
  crowdfundAddress: string | null
  usdcAddress: string | null
  hopStats: HopStatsData[]
  cappedDemand: bigint
  saleSize: bigint
  needsApproval: (amount: bigint) => boolean
  refreshAllowance: () => Promise<void>
  onReceiptLogs?: (logs: readonly ReceiptLogLike[]) => void
  /** Gate: only offer max-out while commits are accepted. */
  windowOpen: boolean
  /** For the confirmation snapshot copy. */
  isAdditionalCommit: boolean
  /** Called once a fresh plan is set, so the flow advances to its review step. */
  onActivated: () => void
}

export interface UseSelfFillResult {
  /** Whether the "max out" affordance applies (window open, provider, headroom). */
  showMaxOut: boolean
  /** Banner props (undefined when not applicable). `onMaxOut` runs activation. */
  maxOutOption: Step2MaxOutOption | undefined
  /** True once a fresh plan has been activated (review/pipeline use the bundle). */
  maxMode: boolean
  maxPlan: SelfFillPlan | null
  /** New USDC the active plan commits (number form, for display). */
  maxNewCommitUsd: number
  /** Projected ARM across every hop the active plan tops up. */
  maxEstimatedArm: number
  /** Clear max mode (e.g. on "Back" from the max review). */
  resetMax: () => void
  /** Approve + multicall steps for the active plan (empty if not ready). */
  buildMaxSteps: (signer: Signer) => TxStep[]
  /** Confirmation snapshot for the pipeline run. */
  maxConfirmation: PipelineConfirmation
}

/**
 * Self-fill ("max out") controller state + helpers. Owns the preview plan, the
 * fresh-read activation, the banner option, and the bundled-pipeline inputs;
 * the consuming flow owns its own step machine, pipeline instance, and the
 * banner / review / confirmation JSX.
 */
export function useSelfFill(params: UseSelfFillParams): UseSelfFillResult {
  const {
    positions,
    balance,
    provider,
    walletAddress,
    crowdfundAddress,
    usdcAddress,
    hopStats,
    cappedDemand,
    saleSize,
    needsApproval,
    refreshAllowance,
    onReceiptLogs,
    windowOpen,
    isAdditionalCommit,
    onActivated,
  } = params

  const [maxMode, setMaxMode] = useState(false)
  const [maxPlan, setMaxPlan] = useState<SelfFillPlan | null>(null)
  const [maxLoading, setMaxLoading] = useState(false)
  const [maxError, setMaxError] = useState<string | null>(null)

  const previewPlan = useMemo<SelfFillPlan>(
    () => computeSelfFillPlan(positionsToSelfFillState(positions), { balance }),
    [positions, balance],
  )
  const showMaxOut =
    windowOpen && !!provider && previewPlan.eligible && previewPlan.newCommitUsdc > 0n

  const activateMaxOut = async () => {
    if (!crowdfundAddress || !walletAddress || !provider) {
      setMaxError('Wallet not ready — reconnect and retry.')
      return
    }
    setMaxLoading(true)
    setMaxError(null)
    try {
      const state = await fetchSelfFillState(provider, crowdfundAddress, walletAddress)
      const plan = computeSelfFillPlan(state, { balance })
      if (!plan.eligible || (plan.newCommitUsdc === 0n && plan.totalInvites === 0)) {
        setMaxError('Nothing left to maximize — you may already be at your ceiling.')
        return
      }
      setMaxPlan(plan)
      setMaxMode(true)
      onActivated()
    } catch (err) {
      setMaxError(err instanceof Error ? err.message : 'Could not prepare the max-out bundle.')
    } finally {
      setMaxLoading(false)
    }
  }

  const maxOutOption: Step2MaxOutOption | undefined = showMaxOut
    ? {
        ceilingUsd: usdcToNumber(previewPlan.projectedCeilingUsdc),
        newCommitUsd: usdcToNumber(previewPlan.newCommitUsdc),
        inviteCount: previewPlan.totalInvites,
        onMaxOut: () => void activateMaxOut(),
        loading: maxLoading,
        balanceLimited: previewPlan.balanceLimited,
        error: maxError ?? undefined,
      }
    : undefined

  const maxNewCommitUsd = maxPlan ? usdcToNumber(maxPlan.newCommitUsdc) : 0

  const maxEstimatedArm = useMemo(() => {
    if (!maxPlan) return 0
    const projected: UserHopPosition[] = ([0, 1, 2] as const)
      .map((h) => ({
        hop: h,
        committed: maxPlan.projectedCapByHop[h],
        effectiveCap: maxPlan.projectedCapByHop[h],
      }))
      .filter((p) => p.committed > 0n)
    return armToNumber(
      estimateUserArmAllocation(projected, hopStats, cappedDemand + maxPlan.newCommitUsdc, saleSize),
    )
  }, [maxPlan, hopStats, cappedDemand, saleSize])

  const resetMax = () => {
    setMaxMode(false)
    setMaxPlan(null)
  }

  const buildMaxSteps = (signer: Signer): TxStep[] => {
    if (!maxPlan || !walletAddress || !usdcAddress || !crowdfundAddress) return []
    return buildSelfFillSteps({
      signer,
      selfAddress: walletAddress,
      plan: maxPlan,
      usdcAddress,
      crowdfundAddress,
      needsApproval,
      refreshAllowance,
      onReceiptLogs,
    })
  }

  const maxConfirmation: PipelineConfirmation = {
    amount: maxNewCommitUsd,
    estimatedArm: Math.round(maxEstimatedArm),
    isAdditionalCommit,
    totalCommittedUsdc: maxPlan ? usdcToNumber(maxPlan.totalCommittedAfterUsdc) : 0,
    maxedOut: false,
  }

  return {
    showMaxOut,
    maxOutOption,
    maxMode,
    maxPlan,
    maxNewCommitUsd,
    maxEstimatedArm,
    resetMax,
    buildMaxSteps,
    maxConfirmation,
  }
}
