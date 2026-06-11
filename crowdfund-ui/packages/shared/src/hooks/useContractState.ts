// ABOUTME: Polls aggregate contract state (phase, timing, hop stats, sale params).
// ABOUTME: Read-only hook backed by react-query — 15+ contract reads batched per poll cycle.

import { useMemo } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CROWDFUND_ABI_FRAGMENTS } from '../lib/constants.js'
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
  // allSettled (not Promise.all) so one flaky read doesn't void the whole tick:
  // each field carries forward its previous value when its read fails. If EVERY
  // read fails (RPC down), we still throw so the error surfaces.
  const settled = await Promise.allSettled([
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
    provider.getBlock('latest'),
  ])

  if (settled.every((s) => s.status === 'rejected')) {
    throw (settled[0] as PromiseRejectedResult).reason
  }

  const ok = <T,>(i: number): T | undefined =>
    settled[i].status === 'fulfilled'
      ? (settled[i] as PromiseFulfilledResult<T>).value
      : undefined

  const phase = ok<bigint>(0)
  const armLoaded = ok<boolean>(1)
  const totalCommitted = ok<bigint>(2)
  const estimatedCapped = ok<[bigint, bigint[]]>(3)
  const saleSize = ok<bigint>(4)
  const windowStart = ok<bigint>(5)
  const windowEnd = ok<bigint>(6)
  const launchTeamInviteEnd = ok<bigint>(7)
  const finalizedAt = ok<bigint>(8)
  const claimDeadline = ok<bigint>(9)
  const refundMode = ok<boolean>(10)
  const participantCount = ok<bigint>(11)
  const hopStats0 = ok<[bigint, bigint, bigint, bigint]>(12)
  const hopStats1 = ok<[bigint, bigint, bigint, bigint]>(13)
  const hopStats2 = ok<[bigint, bigint, bigint, bigint]>(14)
  const block = ok<Awaited<ReturnType<JsonRpcProvider['getBlock']>>>(15)

  const perHopCapped = estimatedCapped?.[1]
  const parseHopStats = (
    raw: [bigint, bigint, bigint, bigint] | undefined,
    hop: number,
    prevHop: HopStatsData,
  ): HopStatsData =>
    raw
      ? {
          totalCommitted: raw[0],
          cappedCommitted: perHopCapped?.[hop] ?? raw[1],
          uniqueCommitters: Number(raw[2]),
          whitelistCount: Number(raw[3]),
        }
      : prevHop

  return {
    phase: phase !== undefined ? Number(phase) : prev.phase,
    armLoaded: armLoaded ?? prev.armLoaded,
    totalCommitted: totalCommitted ?? prev.totalCommitted,
    cappedDemand: estimatedCapped ? estimatedCapped[0] : prev.cappedDemand,
    saleSize: saleSize ?? prev.saleSize,
    windowStart: windowStart !== undefined ? Number(windowStart) : prev.windowStart,
    windowEnd: windowEnd !== undefined ? Number(windowEnd) : prev.windowEnd,
    launchTeamInviteEnd:
      launchTeamInviteEnd !== undefined ? Number(launchTeamInviteEnd) : prev.launchTeamInviteEnd,
    finalizedAt: finalizedAt !== undefined ? Number(finalizedAt) : prev.finalizedAt,
    claimDeadline: claimDeadline !== undefined ? Number(claimDeadline) : prev.claimDeadline,
    refundMode: refundMode ?? prev.refundMode,
    blockTimestamp: block?.timestamp ?? prev.blockTimestamp,
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
