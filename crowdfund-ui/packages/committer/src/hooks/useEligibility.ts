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
}

export interface UseEligibilityResult {
  eligible: boolean
  positions: HopPosition[]
  totalCommitted: bigint
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
      return { eligible: false, positions: [], totalCommitted: 0n }
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
      })

      totalCommitted += node.committed
    }

    return {
      eligible: positions.length > 0,
      positions,
      totalCommitted,
    }
  }, [address, nodes])
}
