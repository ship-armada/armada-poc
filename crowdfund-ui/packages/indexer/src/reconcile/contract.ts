// ABOUTME: Contract-read reconciliation for verified crowdfund snapshots.
// ABOUTME: Compares event-derived graph aggregates against on-chain aggregate reads.

import { Contract } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS } from '../../../shared/src/lib/constants.js'
import type { JsonRpcProvider } from 'ethers'
import type { CrowdfundGraph, GraphNode } from '../../../shared/src/lib/graph.js'
import type { ReconciliationResult } from '../types.js'

export interface HopStatsRead {
  totalCommitted: bigint
  cappedCommitted: bigint
  uniqueCommitters: bigint | number
  whitelistCount: bigint | number
}

export interface EstimatedCappedDemandRead {
  globalCapped: bigint
  perHopCapped: readonly bigint[]
}

export interface CrowdfundReadable {
  getParticipantCount(): Promise<bigint | number>
  getHopStats(hop: number): Promise<HopStatsRead | readonly [bigint, bigint, bigint, bigint]>
  getEstimatedCappedDemand(): Promise<EstimatedCappedDemandRead | readonly [bigint, readonly bigint[]]>
}

export interface ReconcileSnapshotInput {
  graph: CrowdfundGraph
  contract: CrowdfundReadable
  checkedBlock: number
  providerName: string
}

export interface GraphAggregateStats {
  participantCount: number
  perHopTotalCommitted: readonly [bigint, bigint, bigint]
  perHopCappedCommitted: readonly [bigint, bigint, bigint]
  perHopUniqueCommitters: readonly [number, number, number]
  perHopWhitelistCount: readonly [number, number, number]
}

function parseHopStats(raw: HopStatsRead | readonly [bigint, bigint, bigint, bigint]): HopStatsRead {
  if (Array.isArray(raw)) {
    const tuple = raw as readonly [bigint, bigint, bigint, bigint]
    return {
      totalCommitted: tuple[0],
      cappedCommitted: tuple[1],
      uniqueCommitters: tuple[2],
      whitelistCount: tuple[3],
    }
  }
  return raw as HopStatsRead
}

function parseEstimated(raw: EstimatedCappedDemandRead | readonly [bigint, readonly bigint[]]): EstimatedCappedDemandRead {
  if (Array.isArray(raw)) {
    const tuple = raw as readonly [bigint, readonly bigint[]]
    return {
      globalCapped: tuple[0],
      perHopCapped: tuple[1],
    }
  }
  return raw as EstimatedCappedDemandRead
}

function nodeHasWhitelist(node: GraphNode): boolean {
  return node.invitesReceived > 0
}

export function deriveGraphAggregateStats(graph: CrowdfundGraph): GraphAggregateStats {
  const perHopTotalCommitted: [bigint, bigint, bigint] = [0n, 0n, 0n]
  const perHopCappedCommitted: [bigint, bigint, bigint] = [0n, 0n, 0n]
  const perHopUniqueCommitters: [number, number, number] = [0, 0, 0]
  const perHopWhitelistCount: [number, number, number] = [0, 0, 0]

  for (const node of graph.nodes.values()) {
    if (node.hop < 0 || node.hop > 2) continue
    perHopTotalCommitted[node.hop] += node.rawDeposited
    perHopCappedCommitted[node.hop] += node.committed
    if (node.rawDeposited > 0n) perHopUniqueCommitters[node.hop] += 1
    if (nodeHasWhitelist(node)) perHopWhitelistCount[node.hop] += node.invitesReceived
  }

  return {
    participantCount: graph.summaries.size,
    perHopTotalCommitted,
    perHopCappedCommitted,
    perHopUniqueCommitters,
    perHopWhitelistCount,
  }
}

function addMismatch(mismatches: string[], label: string, expected: bigint | number, actual: bigint | number): void {
  if (expected !== actual) {
    mismatches.push(`${label}: expected ${expected.toString()}, got ${actual.toString()}`)
  }
}

export async function reconcileSnapshot(input: ReconcileSnapshotInput): Promise<ReconciliationResult> {
  const stats = deriveGraphAggregateStats(input.graph)
  const [participantCount, estimated, hop0, hop1, hop2] = await Promise.all([
    input.contract.getParticipantCount(),
    input.contract.getEstimatedCappedDemand(),
    input.contract.getHopStats(0),
    input.contract.getHopStats(1),
    input.contract.getHopStats(2),
  ])

  const parsedEstimated = parseEstimated(estimated)
  const hopStats = [parseHopStats(hop0), parseHopStats(hop1), parseHopStats(hop2)] as const
  const mismatches: string[] = []

  addMismatch(mismatches, 'participantCount', BigInt(stats.participantCount), BigInt(participantCount))
  const derivedGlobalCapped = stats.perHopCappedCommitted[0] + stats.perHopCappedCommitted[1] + stats.perHopCappedCommitted[2]
  addMismatch(mismatches, 'globalCapped', derivedGlobalCapped, parsedEstimated.globalCapped)

  for (let hop = 0; hop < 3; hop++) {
    addMismatch(mismatches, `hop${hop}.totalCommitted`, stats.perHopTotalCommitted[hop], hopStats[hop].totalCommitted)
    addMismatch(mismatches, `hop${hop}.cappedCommitted`, stats.perHopCappedCommitted[hop], parsedEstimated.perHopCapped[hop] ?? hopStats[hop].cappedCommitted)
    addMismatch(mismatches, `hop${hop}.uniqueCommitters`, stats.perHopUniqueCommitters[hop], Number(hopStats[hop].uniqueCommitters))
    addMismatch(mismatches, `hop${hop}.whitelistCount`, stats.perHopWhitelistCount[hop], Number(hopStats[hop].whitelistCount))
  }

  return {
    status: mismatches.length === 0 ? 'passed' : 'failed',
    checkedBlock: input.checkedBlock,
    provider: input.providerName,
    checkedAt: new Date().toISOString(),
    mismatches,
  }
}

export function createReadableCrowdfundContract(
  provider: JsonRpcProvider,
  contractAddress: string,
): CrowdfundReadable {
  return new Contract(contractAddress, CROWDFUND_ABI_FRAGMENTS, provider) as unknown as CrowdfundReadable
}
