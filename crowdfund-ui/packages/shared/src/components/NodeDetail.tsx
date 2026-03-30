// ABOUTME: Expanded detail view for a single participant address.
// ABOUTME: Shows per-hop breakdown of commitment, cap, allocation, and invite info.

import { formatUsdc, formatArm, hopLabel, truncateAddress } from '../lib/format.js'
import { HOP_CONFIGS } from '../lib/constants.js'
import type { AddressSummary, GraphNode } from '../lib/graph.js'

export interface NodeDetailProps {
  summary: AddressSummary
  hopNodes: GraphNode[]
  resolveENS?: (addr: string) => string | null
  phase: number
}

function displayAddress(addr: string, resolve?: (a: string) => string | null): string {
  if (addr === 'armada') return 'Armada'
  const ens = resolve?.(addr)
  return ens ?? truncateAddress(addr)
}

export function NodeDetail(props: NodeDetailProps) {
  const { summary, hopNodes, resolveENS, phase } = props

  return (
    <div className="space-y-3 text-sm">
      {/* Address header */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{summary.address}</span>
        {resolveENS?.(summary.address) && (
          <span className="text-xs text-foreground">{resolveENS(summary.address)}</span>
        )}
      </div>

      {/* Invited by */}
      <div className="text-xs text-muted-foreground">
        Invited by: {displayAddress(summary.displayInviter, resolveENS)}
      </div>

      {/* Total committed */}
      <div>
        <span className="text-muted-foreground">Total committed: </span>
        <span className="font-medium">{formatUsdc(summary.totalCommitted)}</span>
      </div>

      {/* Per-hop breakdown */}
      <div className="space-y-2">
        {hopNodes.map((node) => {
          const cap = node.hop < HOP_CONFIGS.length ? HOP_CONFIGS[node.hop].capUsdc : 0n
          const maxCommit = BigInt(node.invitesReceived) * cap

          return (
            <div
              key={`${node.address}-${node.hop}`}
              className="rounded border border-border p-2"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-xs">{hopLabel(node.hop)}</span>
                <span className="text-xs text-muted-foreground">
                  {node.invitesReceived} invite{node.invitesReceived !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <div>
                  <span className="text-muted-foreground">Committed: </span>
                  <span>{formatUsdc(node.committed)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Cap: </span>
                  <span>{formatUsdc(maxCommit)}</span>
                </div>
                {node.rawDeposited > node.committed && (
                  <div className="col-span-2 text-amber-500">
                    Over-cap by {formatUsdc(node.rawDeposited - node.committed)}
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Invites used: </span>
                  <span>{node.invitesUsed}/{node.invitesUsed + node.invitesAvailable}</span>
                </div>
                {/* Post-finalization allocation */}
                {phase === 1 && node.acceptedUsdc !== null && (
                  <div>
                    <span className="text-muted-foreground">Accepted: </span>
                    <span>{formatUsdc(node.acceptedUsdc)}</span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Post-finalization: aggregate allocation */}
      {phase === 1 && summary.allocatedArm !== null && (
        <div className="rounded border border-success/30 bg-success/5 p-2 space-y-1">
          <div className="text-xs">
            <span className="text-muted-foreground">ARM allocated: </span>
            <span className="font-medium text-success">{formatArm(summary.allocatedArm)}</span>
          </div>
          {summary.refundUsdc !== null && summary.refundUsdc > 0n && (
            <div className="text-xs">
              <span className="text-muted-foreground">USDC refund: </span>
              <span>{formatUsdc(summary.refundUsdc)}</span>
            </div>
          )}
          {summary.delegate && (
            <div className="text-xs">
              <span className="text-muted-foreground">Delegate: </span>
              <span>{displayAddress(summary.delegate, resolveENS)}</span>
            </div>
          )}
          <div className="flex gap-3 text-xs">
            {summary.armClaimed && (
              <span className="text-success">ARM claimed</span>
            )}
            {summary.refundClaimed && (
              <span className="text-success">Refund claimed</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
