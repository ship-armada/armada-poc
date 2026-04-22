// ABOUTME: Expanded detail view for a single participant address.
// ABOUTME: Shows per-hop breakdown of commitment, cap, allocation, and invite info.

import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { formatUsdc, formatArm, hopLabel, truncateAddress } from '../lib/format.js'
import type { AddressSummary, GraphNode } from '../lib/graph.js'
import { Button } from './ui/button.js'
import { CopyToast } from './CopyToast.js'

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
  const ensName = resolveENS?.(summary.address)

  // Compute total invites used / available across all hops
  let totalInvitesUsed = 0
  let totalInvitesAvailable = 0
  for (const node of hopNodes) {
    totalInvitesUsed += node.invitesUsed
    totalInvitesAvailable += node.invitesUsed + node.invitesAvailable
  }

  // Build per-hop inviter chain for multi-hop addresses
  const inviterChain = hopNodes.map((node) => {
    const inviter = node.invitedBy.length > 0 ? node.invitedBy[0] : null
    const isSelfInvite = inviter === summary.address
    const isSeed = node.hop === 0
    return {
      hop: node.hop,
      inviter,
      label: isSeed
        ? 'Armada (seed)'
        : isSelfInvite
          ? 'self-invited'
          : inviter
            ? displayAddress(inviter, resolveENS)
            : 'unknown',
    }
  })

  return (
    <div className="space-y-2 text-sm">
      {/* Address header: ENS name (truncated address) */}
      <div className="font-medium">
        {ensName ? (
          <span>
            {ensName}{' '}
            <span className="font-mono text-xs text-muted-foreground">
              ({truncateAddress(summary.address)})
            </span>
          </span>
        ) : (
          <span className="font-mono text-xs">{summary.address}</span>
        )}
      </div>

      {/* Per-hop breakdown: compact inline format */}
      {hopNodes.map((node) => {
        const slotCount = node.invitesReceived
        return (
          <div key={`${node.address}-${node.hop}`} className="text-xs">
            <span className="text-muted-foreground">{hopLabel(node.hop)}: </span>
            <span>{formatUsdc(node.committed)} committed</span>
            {slotCount > 1 && (
              <span className="text-muted-foreground"> ({slotCount} slots)</span>
            )}
            {slotCount === 1 && node.hop > 0 && (
              <span className="text-muted-foreground"> (1 slot)</span>
            )}
            {node.rawDeposited > node.committed && (
              <span className="text-amber-500">
                {' '}(over-cap by {formatUsdc(node.rawDeposited - node.committed)})
              </span>
            )}
          </div>
        )
      })}

      {/* Total (only shown for multi-hop) */}
      {hopNodes.length > 1 && (
        <div className="text-xs font-medium">
          Total: {formatUsdc(summary.totalCommitted)}
        </div>
      )}

      {/* Invited by: per-hop inviter chain */}
      <div className="text-xs text-muted-foreground">
        Invited by:{' '}
        {inviterChain.map((entry, idx) => {
          const copyable =
            entry.inviter !== null && entry.inviter !== summary.address && entry.hop !== 0
          return (
            <span key={entry.hop} className="inline-flex items-center gap-1">
              {idx > 0 && ' · '}
              {hopNodes.length > 1 && <span>{hopLabel(entry.hop)}: </span>}
              <span>{entry.label}</span>
              {copyable && entry.inviter && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Copy inviter address"
                  className="h-auto p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigator.clipboard.writeText(entry.inviter!).then(
                      () => toast.success(<CopyToast>Address copied</CopyToast>),
                      () => toast.error('Clipboard write failed'),
                    )
                  }}
                >
                  <Copy className="size-3" />
                </Button>
              )}
            </span>
          )
        })}
      </div>

      {/* Invite usage summary */}
      <div className="text-xs text-muted-foreground">
        Invites: {totalInvitesUsed}/{totalInvitesAvailable} used
      </div>

      {/* Post-finalization: allocation and claim status */}
      {phase === 1 && summary.allocatedArm !== null && (
        <div className="pt-1 border-t border-border space-y-1">
          <div className="text-xs">
            <span className="text-muted-foreground">Allocated: </span>
            <span className="font-medium text-success">{formatArm(summary.allocatedArm)}</span>
          </div>
          {summary.refundUsdc !== null && summary.refundUsdc > 0n && (
            <div className="text-xs">
              <span className="text-muted-foreground">Refund: </span>
              <span>{formatUsdc(summary.refundUsdc)}</span>
            </div>
          )}
          {summary.delegate && (
            <div className="text-xs">
              <span className="text-muted-foreground">Delegate: </span>
              <span>{displayAddress(summary.delegate, resolveENS)}</span>
            </div>
          )}
          <div className="text-xs">
            <span className="text-muted-foreground">ARM claimed: </span>
            <span>{summary.armClaimed ? '\u2713' : '\u2717'}</span>
            <span className="mx-2 text-border">|</span>
            <span className="text-muted-foreground">Refund claimed: </span>
            <span>{summary.refundClaimed ? '\u2713' : '\u2717'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
