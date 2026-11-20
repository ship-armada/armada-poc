// ABOUTME: Detects which hops the connected address is invited to.
// ABOUTME: Scans events and contract state to determine per-hop positions.

import { useMemo } from 'react'
import {
  type GraphNode,
  HOP_CONFIGS,
} from '@armada/crowdfund-shared'

export interface HopPosition {
  hop: number
  invitesReceived: number
  committed: bigint
  effectiveCap: bigint
  remaining: bigint
  invitesUsed: number
  invitesAvailable: number
  invitedBy: string[]
}

export interface CommitPositionSplit {
  /** Positions with commit capacity (effective cap above $0) — the ones the commit flow offers. */
  commitPositions: HopPosition[]
  /** At least one position can take a commit. */
  canCommit: boolean
  /** Every position has a $0 cap (e.g. a relaunch team inviter wallet): invites are the only action. */
  inviteOnly: boolean
}

export interface UseEligibilityResult extends CommitPositionSplit {
  eligible: boolean
  positions: HopPosition[]
  totalCommitted: bigint
}

/** Separate the positions the commit flow can offer from $0-cap positions. */
export function splitCommitPositions(positions: HopPosition[]): CommitPositionSplit {
  const commitPositions = positions.filter((p) => p.effectiveCap > 0n)
  return {
    commitPositions,
    canCommit: commitPositions.length > 0,
    inviteOnly: positions.length > 0 && commitPositions.length === 0,
  }
}

/**
 * Determine the connected address's eligibility and per-hop positions.
 * Uses the graph nodes to derive state without additional RPC calls.
 */
export function useEligibility(
  address: string | null,
  nodes: Map<string, GraphNode>,
): UseEligibilityResult {
  return useMemo(() => {
    if (!address) {
      return { eligible: false, positions: [], totalCommitted: 0n, ...splitCommitPositions([]) }
    }

    const positions: HopPosition[] = []
    let totalCommitted = 0n

    for (let hop = 0; hop < 3; hop++) {
      const node = nodes.get(`${address.toLowerCase()}-${hop}`)
      if (!node || node.invitesReceived === 0) continue

      const cap = hop < HOP_CONFIGS.length ? HOP_CONFIGS[hop].capUsdc : 0n
      const effectiveCap = BigInt(node.invitesReceived) * cap
      const remaining = effectiveCap > node.committed ? effectiveCap - node.committed : 0n

      positions.push({
        hop,
        invitesReceived: node.invitesReceived,
        committed: node.committed,
        effectiveCap,
        remaining,
        invitesUsed: node.invitesUsed,
        invitesAvailable: node.invitesAvailable,
        invitedBy: node.invitedBy,
      })

      totalCommitted += node.committed
    }

    return {
      eligible: positions.length > 0,
      positions,
      totalCommitted,
      ...splitCommitPositions(positions),
    }
  }, [address, nodes])
}
