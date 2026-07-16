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

// ethers v6 accepts a trailing overrides object on read calls; `blockTag` pins the
// read to a historical block so reconciliation compares the graph and the chain at the
// SAME height (the snapshot's verifiedCursor), not at `latest`.
export interface CrowdfundReadOverrides {
  blockTag?: number
}

export interface CrowdfundReadable {
  getParticipantCount(overrides?: CrowdfundReadOverrides): Promise<bigint | number>
  getHopStats(hop: number, overrides?: CrowdfundReadOverrides): Promise<HopStatsRead | readonly [bigint, bigint, bigint, bigint]>
  getEstimatedCappedDemand(overrides?: CrowdfundReadOverrides): Promise<EstimatedCappedDemandRead | readonly [bigint, readonly bigint[]]>
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
  // Counts distinct whitelisted (address, hop) nodes to match the contract's
  // getParticipantCount() == participantNodes.length, which counts (address, hop)
  // pairs. A multi-hop address is one node per hop, not de-duplicated by address.
  let participantCount = 0

  for (const node of graph.nodes.values()) {
    if (node.hop < 0 || node.hop > 2) continue
    perHopTotalCommitted[node.hop] += node.rawDeposited
    perHopCappedCommitted[node.hop] += node.committed
    if (node.rawDeposited > 0n) perHopUniqueCommitters[node.hop] += 1
    // hopStats[hop].whitelistCount on-chain counts distinct whitelisted addresses
    // at the hop; a re-invited node stacks invitesReceived but is whitelisted once,
    // so count the node, not its invites.
    if (nodeHasWhitelist(node)) {
      perHopWhitelistCount[node.hop] += 1
      participantCount += 1
    }
  }

  return {
    participantCount,
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

// Non-archive nodes prune historical state, so a blockTag read at an old block can fail
// with a "missing trie node"/"state not available" error. That is not a reconciliation
// failure — it means we cannot check at this height, so we degrade to `pending` (the
// same status used when no audit RPC is configured) rather than blocking publishing.
function isHistoricalStateUnavailable(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('missing trie node') ||
    message.includes('historical state') ||
    message.includes('state is not available') ||
    message.includes('state not available') ||
    message.includes('missing state') ||
    message.includes('header not found')
  )
}

export async function reconcileSnapshot(input: ReconcileSnapshotInput): Promise<ReconciliationResult> {
  const stats = deriveGraphAggregateStats(input.graph)
  // Pin all reads to the snapshot's verified block so the chain side and the
  // event-derived side are compared at the same height.
  const overrides: CrowdfundReadOverrides = { blockTag: input.checkedBlock }
  let participantCount: bigint | number
  let estimated: EstimatedCappedDemandRead | readonly [bigint, readonly bigint[]]
  let hop0: HopStatsRead | readonly [bigint, bigint, bigint, bigint]
  let hop1: HopStatsRead | readonly [bigint, bigint, bigint, bigint]
  let hop2: HopStatsRead | readonly [bigint, bigint, bigint, bigint]
  try {
    [participantCount, estimated, hop0, hop1, hop2] = await Promise.all([
      input.contract.getParticipantCount(overrides),
      input.contract.getEstimatedCappedDemand(overrides),
      input.contract.getHopStats(0, overrides),
      input.contract.getHopStats(1, overrides),
      input.contract.getHopStats(2, overrides),
    ])
  } catch (err) {
    if (isHistoricalStateUnavailable(err)) {
      const reason = err instanceof Error ? err.message : String(err)
      return {
        status: 'pending',
        checkedBlock: input.checkedBlock,
        provider: input.providerName,
        checkedAt: new Date().toISOString(),
        mismatches: [
          `Reconciliation skipped: historical state at block ${input.checkedBlock} unavailable from ${input.providerName} (non-archive node): ${reason}`,
        ],
      }
    }
    throw err
  }

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
