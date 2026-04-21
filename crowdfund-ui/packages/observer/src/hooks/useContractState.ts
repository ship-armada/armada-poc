// ABOUTME: Polls aggregate contract state (phase, timing, hop stats, sale params).
// ABOUTME: Read-only hook backed by react-query — 15+ contract reads batched per poll cycle.

import { useMemo } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { useQuery } from '@tanstack/react-query'
import {
  CROWDFUND_ABI_FRAGMENTS,
  type HopStatsData,
} from '@armada/crowdfund-shared'

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

async function fetchContractState(
  provider: JsonRpcProvider,
  contract: Contract,
): Promise<Omit<ContractState, 'loading' | 'error'>> {
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
    provider.getBlock('latest'),
  ])

  const estimated = estimatedCapped as [bigint, bigint[]]
  const perHopCapped = estimated[1]

  const parseHopStats = (
    raw: [bigint, bigint, bigint, bigint],
    hop: number,
  ): HopStatsData => ({
    totalCommitted: raw[0],
    cappedCommitted: perHopCapped[hop] ?? raw[1],
    uniqueCommitters: Number(raw[2]),
    whitelistCount: Number(raw[3]),
  })

  // Seed count is hop-0 whitelist count
  const seedCount = Number(hopStats0[3])

  return {
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
    hopStats: [
      parseHopStats(hopStats0, 0),
      parseHopStats(hopStats1, 1),
      parseHopStats(hopStats2, 2),
    ],
    participantCount: Number(participantCount),
    seedCount,
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

  const query = useQuery({
    queryKey: ['crowdfundContractState', contractAddress],
    queryFn: () => fetchContractState(provider!, contract!),
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
