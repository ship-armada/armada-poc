// ABOUTME: Derives participant table data from the CrowdfundGraph.
// ABOUTME: Avoids N+1 RPC reads by using event-derived graph state.

import { useMemo } from 'react'
import {
  type CrowdfundEvent,
  buildGraph,
  HOP_CONFIGS,
} from '@armada/crowdfund-shared'

export interface ParticipantRow {
  address: string
  hop: number
  invitedBy: string[]
  invitesReceived: number
  effectiveCap: bigint
  committed: bigint
  invitesUsed: number
  invitesTotal: number
  allocatedArm: bigint | null
  refundUsdc: bigint | null
  armClaimed: boolean
  refundClaimed: boolean
}

export function useParticipants(events: CrowdfundEvent[]): ParticipantRow[] {
  return useMemo(() => {
    if (events.length === 0) return []

    const graph = buildGraph(events)
    const rows: ParticipantRow[] = []

    // Track allocations from events
    const allocations = new Map<string, { arm: bigint; refund: bigint }>()
    const refundClaims = new Set<string>()

    for (const event of events) {
      if (event.type === 'Allocated') {
        const addr = (event.args.participant as string).toLowerCase()
        allocations.set(addr, {
          arm: event.args.armTransferred as bigint,
          refund: event.args.refundUsdc as bigint,
        })
      }
      if (event.type === 'RefundClaimed') {
        refundClaims.add((event.args.participant as string).toLowerCase())
      }
    }

    for (const [, node] of graph.nodes) {
      const cap = node.hop < HOP_CONFIGS.length ? HOP_CONFIGS[node.hop].capUsdc : 0n
      const effectiveCap = BigInt(node.invitesReceived) * cap
      const maxInvites = node.hop < HOP_CONFIGS.length ? HOP_CONFIGS[node.hop].maxInvites : 0
      const alloc = allocations.get(node.address)

      rows.push({
        address: node.address,
        hop: node.hop,
        invitedBy: node.invitedBy,
        invitesReceived: node.invitesReceived,
        effectiveCap,
        committed: node.committed,
        invitesUsed: node.invitesUsed,
        invitesTotal: maxInvites,
        allocatedArm: alloc?.arm ?? null,
        refundUsdc: alloc?.refund ?? null,
        armClaimed: allocations.has(node.address),
        refundClaimed: refundClaims.has(node.address),
      })
    }

    // Sort by committed descending
    rows.sort((a, b) => (b.committed > a.committed ? 1 : b.committed < a.committed ? -1 : 0))

    return rows
  }, [events])
}
