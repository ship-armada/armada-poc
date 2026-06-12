// ABOUTME: Polls aggregate contract state (phase, timing, hop stats, sale params).
// ABOUTME: Read-only hook backed by react-query — 15+ contract reads batched per poll cycle.

import { useMemo } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider, Result } from 'ethers'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CROWDFUND_ABI_FRAGMENTS } from '../lib/constants.js'
import { aggregate3, getMulticall3Contract, type AggregateCall } from '../lib/multicall3.js'
import type { HopStatsData } from '../components/StatsBar.js'

export interface ContractState {
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
  loading: boolean
  error: string | null
}

const INITIAL_STATE: Omit<ContractState, 'loading' | 'error'> = {
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
}

type ContractSnapshot = Omit<ContractState, 'loading' | 'error'>

async function fetchContractState(
  provider: JsonRpcProvider,
  contract: Contract,
  prev: ContractSnapshot,
): Promise<ContractSnapshot> {
  // One Multicall3 `aggregate3` (allowFailure: true) replaces 16 separate
  // eth_calls. The block timestamp is folded in via Multicall3's
  // `getCurrentBlockTimestamp()` for a consistent same-block snapshot. Each
  // sub-call carries forward its previous value when it fails; if EVERY sub-call
  // fails (RPC/contract down) we throw so the error surfaces — mirroring the
  // prior `Promise.allSettled` contract.
  const mc = getMulticall3Contract(provider)
  const calls: AggregateCall[] = [
    { contract, functionName: 'phase' },
    { contract, functionName: 'armLoaded' },
    { contract, functionName: 'totalCommitted' },
    { contract, functionName: 'getEstimatedCappedDemand' },
    { contract, functionName: 'saleSize' },
    { contract, functionName: 'windowStart' },
    { contract, functionName: 'windowEnd' },
    { contract, functionName: 'launchTeamInviteEnd' },
    { contract, functionName: 'finalizedAt' },
    { contract, functionName: 'claimDeadline' },
    { contract, functionName: 'refundMode' },
    { contract, functionName: 'getParticipantCount' },
    { contract, functionName: 'getHopStats', args: [0] },
    { contract, functionName: 'getHopStats', args: [1] },
    { contract, functionName: 'getHopStats', args: [2] },
    { contract: mc, functionName: 'getCurrentBlockTimestamp' },
  ]

  const results = await aggregate3(provider, calls)
  if (results.every((r) => !r.success)) {
    throw new Error('All contract reads failed')
  }

  // Single-return reads decode to a one-element tuple; multi-return reads keep
  // the whole Result for positional access.
  const single = <T,>(i: number): T | undefined =>
    results[i].success ? (results[i].result![0] as T) : undefined
  const tuple = (i: number): Result | undefined => (results[i].success ? results[i].result : undefined)

  const phase = single<bigint>(0)
  const armLoaded = single<boolean>(1)
  const totalCommitted = single<bigint>(2)
  const estimatedCapped = tuple(3)
  const saleSize = single<bigint>(4)
  const windowStart = single<bigint>(5)
  const windowEnd = single<bigint>(6)
  const launchTeamInviteEnd = single<bigint>(7)
  const finalizedAt = single<bigint>(8)
  const claimDeadline = single<bigint>(9)
  const refundMode = single<boolean>(10)
  const participantCount = single<bigint>(11)
  const hopStats0 = tuple(12)
  const hopStats1 = tuple(13)
  const hopStats2 = tuple(14)
  const blockTimestamp = single<bigint>(15)

  const perHopCapped = estimatedCapped?.[1] as bigint[] | undefined
  const parseHopStats = (
    raw: Result | undefined,
    hop: number,
    prevHop: HopStatsData,
  ): HopStatsData =>
    raw
      ? {
          totalCommitted: raw[0] as bigint,
          cappedCommitted: perHopCapped?.[hop] ?? (raw[1] as bigint),
          uniqueCommitters: Number(raw[2]),
          whitelistCount: Number(raw[3]),
        }
      : prevHop

  return {
    phase: phase !== undefined ? Number(phase) : prev.phase,
    armLoaded: armLoaded ?? prev.armLoaded,
    totalCommitted: totalCommitted ?? prev.totalCommitted,
    cappedDemand: estimatedCapped ? (estimatedCapped[0] as bigint) : prev.cappedDemand,
    saleSize: saleSize ?? prev.saleSize,
    windowStart: windowStart !== undefined ? Number(windowStart) : prev.windowStart,
    windowEnd: windowEnd !== undefined ? Number(windowEnd) : prev.windowEnd,
    launchTeamInviteEnd:
      launchTeamInviteEnd !== undefined ? Number(launchTeamInviteEnd) : prev.launchTeamInviteEnd,
    finalizedAt: finalizedAt !== undefined ? Number(finalizedAt) : prev.finalizedAt,
    claimDeadline: claimDeadline !== undefined ? Number(claimDeadline) : prev.claimDeadline,
    refundMode: refundMode ?? prev.refundMode,
    blockTimestamp: blockTimestamp !== undefined ? Number(blockTimestamp) : prev.blockTimestamp,
    hopStats: [
      parseHopStats(hopStats0, 0, prev.hopStats[0]),
      parseHopStats(hopStats1, 1, prev.hopStats[1]),
      parseHopStats(hopStats2, 2, prev.hopStats[2]),
    ],
    participantCount:
      participantCount !== undefined ? Number(participantCount) : prev.participantCount,
    seedCount: hopStats0 ? Number(hopStats0[3]) : prev.seedCount,
  }
}

export function useContractState(
  provider: JsonRpcProvider | null,
  contractAddress: string | null,
  pollIntervalMs: number,
): ContractState {
  const contract = useMemo(() => {
    if (!provider || !contractAddress) return null
    return new Contract(contractAddress, CROWDFUND_ABI_FRAGMENTS, provider)
  }, [provider, contractAddress])

  const queryClient = useQueryClient()
  const queryKey = useMemo(() => ['crowdfundContractState', contractAddress] as const, [contractAddress])

  const query = useQuery({
    queryKey,
    queryFn: () => {
      // Carry forward the last good snapshot for any field whose read fails.
      const prev = queryClient.getQueryData<ContractSnapshot>(queryKey) ?? INITIAL_STATE
      return fetchContractState(provider!, contract!, prev)
    },
    enabled: !!provider && !!contract,
    refetchInterval: pollIntervalMs,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 10 * 60 * 1000,
    retry: false,
  })

  const data = query.data ?? INITIAL_STATE
  // Preserve the prior `loading` semantic: true until the first successful
  // fetch (matches react-query's isPending for a query that has no data yet).
  const loading = query.isPending
  const error = query.error
    ? (query.error instanceof Error ? query.error.message : 'Failed to fetch contract state')
    : null

  return { ...data, loading, error }
}
