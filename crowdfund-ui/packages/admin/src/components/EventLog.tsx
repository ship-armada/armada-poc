// ABOUTME: Scrollable reverse-chronological event log with type filtering.
// ABOUTME: Color-coded event badges, formatted data, and address search.

import { useState, useMemo } from 'react'
import {
  formatUsdc,
  formatArm,
  truncateAddress,
  type CrowdfundEvent,
  type CrowdfundEventType,
} from '@armada/crowdfund-shared'

export interface EventLogProps {
  events: CrowdfundEvent[]
  loading: boolean
}

const EVENT_COLORS: Record<CrowdfundEventType, string> = {
  ArmLoaded: 'bg-success/20 text-success',
  SeedAdded: 'bg-info/20 text-info',
  Invited: 'bg-info/20 text-info',
  Committed: 'bg-primary/20 text-primary',
  Finalized: 'bg-success/20 text-success',
  Cancelled: 'bg-destructive/20 text-destructive',
  Allocated: 'bg-success/20 text-success',
  AllocatedHop: 'bg-success/20 text-success',
  RefundClaimed: 'bg-amber-500/20 text-amber-500',
  InviteNonceRevoked: 'bg-amber-500/20 text-amber-500',
  UnallocatedArmWithdrawn: 'bg-amber-500/20 text-amber-500',
}

const ALL_EVENT_TYPES: CrowdfundEventType[] = [
  'ArmLoaded', 'SeedAdded', 'Invited', 'Committed', 'Finalized',
  'Cancelled', 'Allocated', 'AllocatedHop', 'RefundClaimed',
  'InviteNonceRevoked', 'UnallocatedArmWithdrawn',
]

function formatEventData(event: CrowdfundEvent): string {
  const { args } = event
  switch (event.type) {
    case 'SeedAdded':
      return truncateAddress(args.seed as string)
    case 'Invited':
      return `${truncateAddress(args.inviter as string)} -> ${truncateAddress(args.invitee as string)} hop-${args.hop}`
    case 'Committed':
      return `${truncateAddress(args.participant as string)} ${formatUsdc(args.amount as bigint)} hop-${args.hop}`
    case 'Finalized':
      return `size=${formatUsdc(args.saleSize as bigint)} refund=${args.refundMode ? 'yes' : 'no'}`
    case 'Allocated':
      return `${truncateAddress(args.participant as string)} ${formatArm(args.armTransferred as bigint)}`
    case 'AllocatedHop':
      return `${truncateAddress(args.participant as string)} hop-${args.hop} ${formatUsdc(args.acceptedUsdc as bigint)}`
    case 'RefundClaimed':
      return `${truncateAddress(args.participant as string)} ${formatUsdc(args.usdcAmount as bigint)}`
    case 'InviteNonceRevoked':
      return `${truncateAddress(args.inviter as string)} nonce=${String(args.nonce)}`
    case 'UnallocatedArmWithdrawn':
      return `${truncateAddress(args.treasury as string)} ${formatArm(args.amount as bigint)}`
    default:
      return ''
  }
}

export function EventLog({ events, loading }: EventLogProps) {
  const [typeFilter, setTypeFilter] = useState<Set<CrowdfundEventType>>(new Set(ALL_EVENT_TYPES))
  const [addressSearch, setAddressSearch] = useState('')

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (!typeFilter.has(e.type)) return false
      if (addressSearch) {
        const search = addressSearch.toLowerCase()
        const argsStr = JSON.stringify(e.args).toLowerCase()
        if (!argsStr.includes(search)) return false
      }
      return true
    })
  }, [events, typeFilter, addressSearch])

  const toggleType = (type: CrowdfundEventType) => {
    setTypeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Event Log</h2>
        <span className="text-xs text-muted-foreground">
          {filtered.length} events {loading && '(syncing...)'}
        </span>
      </div>

      {/* Filters */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {ALL_EVENT_TYPES.map((type) => (
            <button
              key={type}
              className={`px-2 py-0.5 rounded text-[10px] ${
                typeFilter.has(type) ? EVENT_COLORS[type] : 'bg-muted/50 text-muted-foreground/50'
              }`}
              onClick={() => toggleType(type)}
            >
              {type}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter by address..."
          value={addressSearch}
          onChange={(e) => setAddressSearch(e.target.value)}
          className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Event list */}
      <div className="max-h-64 overflow-y-auto space-y-1">
        {filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4">No events</div>
        ) : (
          filtered.map((event, i) => (
            <div key={`${event.transactionHash}-${event.logIndex}-${i}`} className="flex items-center gap-2 text-xs py-1 border-b border-border/30">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${EVENT_COLORS[event.type]}`}>
                {event.type}
              </span>
              <span className="text-muted-foreground font-mono">{event.blockNumber}</span>
              <span className="flex-1 truncate">{formatEventData(event)}</span>
              <span className="text-muted-foreground font-mono text-[10px]">
                {event.transactionHash.slice(0, 8)}...
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
