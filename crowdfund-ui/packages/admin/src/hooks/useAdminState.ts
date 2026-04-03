// ABOUTME: Polls aggregate contract state for the admin dashboard.
// ABOUTME: Extends committer's useContractState with LT budget and allocation tracking.

import { useEffect, useState, useRef, useCallback } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  type HopStatsData,
} from '@armada/crowdfund-shared'

export interface AdminState {
  phase: number
  armLoaded: boolean
  totalCommitted: bigint
  cappedDemand: bigint
  saleSize: bigint
  windowStart: number
  windowEnd: number
  launchTeamInviteEnd: number
  finalizedAt: number
  claimDeadline: number
  refundMode: boolean
  blockTimestamp: number
  hopStats: HopStatsData[]
  participantCount: number
  seedCount: number
  ltBudgetHop1Remaining: number
  ltBudgetHop2Remaining: number
  totalAllocatedArm: bigint
  totalArmTransferred: bigint
  loading: boolean
  error: string | null
}

const INITIAL_STATE: AdminState = {
  phase: 0,
  armLoaded: false,
  totalCommitted: 0n,
  cappedDemand: 0n,
  saleSize: 0n,
  windowStart: 0,
  windowEnd: 0,
  launchTeamInviteEnd: 0,
  finalizedAt: 0,
  claimDeadline: 0,
  refundMode: false,
  blockTimestamp: 0,
  hopStats: [
    { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
    { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
    { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
  ],
  participantCount: 0,
  seedCount: 0,
  ltBudgetHop1Remaining: 0,
  ltBudgetHop2Remaining: 0,
  totalAllocatedArm: 0n,
  totalArmTransferred: 0n,
  loading: true,
  error: null,
}

export function useAdminState(
  provider: JsonRpcProvider | null,
  contractAddress: string | null,
  pollIntervalMs: number,
): AdminState {
  const [state, setState] = useState<AdminState>(INITIAL_STATE)
  const contractRef = useRef<Contract | null>(null)

  const refresh = useCallback(async () => {
    if (!provider || !contractAddress) return

    if (!contractRef.current) {
      contractRef.current = new Contract(
        contractAddress,
        CROWDFUND_ABI_FRAGMENTS,
        provider,
      )
    }
    const contract = contractRef.current

    try {
      const [
        phase,
        armLoaded,
        totalCommitted,
        estimatedCapped,
        saleSize,
        windowStart,
        windowEnd,
        launchTeamInviteEnd,
        finalizedAt,
        claimDeadline,
        refundMode,
        participantCount,
        hopStats0,
        hopStats1,
        hopStats2,
        ltBudget,
        totalAllocatedArm,
        totalArmTransferred,
        block,
      ] = await Promise.all([
        contract.phase() as Promise<bigint>,
        contract.armLoaded() as Promise<boolean>,
        contract.totalCommitted() as Promise<bigint>,
        contract.getEstimatedCappedDemand() as Promise<[bigint, bigint[]]>,
        contract.saleSize() as Promise<bigint>,
        contract.windowStart() as Promise<bigint>,
        contract.windowEnd() as Promise<bigint>,
        contract.launchTeamInviteEnd() as Promise<bigint>,
        contract.finalizedAt() as Promise<bigint>,
        contract.claimDeadline() as Promise<bigint>,
        contract.refundMode() as Promise<boolean>,
        contract.getParticipantCount() as Promise<bigint>,
        contract.getHopStats(0) as Promise<[bigint, bigint, bigint, bigint]>,
        contract.getHopStats(1) as Promise<[bigint, bigint, bigint, bigint]>,
        contract.getHopStats(2) as Promise<[bigint, bigint, bigint, bigint]>,
        contract.getLaunchTeamBudgetRemaining() as Promise<[bigint, bigint]>,
        contract.totalAllocatedArm() as Promise<bigint>,
        contract.totalArmTransferred() as Promise<bigint>,
        provider.getBlock('latest'),
      ])

      const estimated = estimatedCapped as [bigint, bigint[]]
      const perHopCapped = estimated[1]

      const parseHopStats = (raw: [bigint, bigint, bigint, bigint], hop: number): HopStatsData => ({
        totalCommitted: raw[0],
        cappedCommitted: perHopCapped[hop] ?? raw[1],
        uniqueCommitters: Number(raw[2]),
        whitelistCount: Number(raw[3]),
      })

      const seedCount = Number(hopStats0[3])

      setState({
        phase: Number(phase),
        armLoaded,
        totalCommitted,
        cappedDemand: estimated[0],
        saleSize,
        windowStart: Number(windowStart),
        windowEnd: Number(windowEnd),
        launchTeamInviteEnd: Number(launchTeamInviteEnd),
        finalizedAt: Number(finalizedAt),
        claimDeadline: Number(claimDeadline),
        refundMode,
        blockTimestamp: block?.timestamp ?? 0,
        hopStats: [parseHopStats(hopStats0, 0), parseHopStats(hopStats1, 1), parseHopStats(hopStats2, 2)],
        participantCount: Number(participantCount),
        seedCount,
        ltBudgetHop1Remaining: Number(ltBudget[0]),
        ltBudgetHop2Remaining: Number(ltBudget[1]),
        totalAllocatedArm,
        totalArmTransferred,
        loading: false,
        error: null,
      })
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch contract state',
      }))
    }
  }, [provider, contractAddress])

  useEffect(() => {
    if (!provider || !contractAddress) return
    contractRef.current = null
    refresh()
    const id = setInterval(refresh, pollIntervalMs)
    return () => clearInterval(id)
  }, [provider, contractAddress, pollIntervalMs, refresh])

  return state
}
