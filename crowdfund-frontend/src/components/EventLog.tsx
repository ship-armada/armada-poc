// ABOUTME: Scrollable event log showing contract events in reverse chronological order.
// ABOUTME: Color-coded by event type with formatted arguments.
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollText } from 'lucide-react'
import type { CrowdfundEvent } from '@/types/crowdfund'
import { truncateAddress } from '@/utils/format'

interface EventLogProps {
  events: CrowdfundEvent[]
}

function eventColor(name: string): string {
  switch (name) {
    case 'SeedAdded':
      return 'bg-info/20 text-info'
    case 'InvitationStarted':
      return 'bg-primary/20 text-primary'
    case 'Invited':
      return 'bg-info/20 text-info'
    case 'Committed':
      return 'bg-warning/20 text-warning'
    case 'Finalized':
      return 'bg-success/20 text-success'
    case 'Cancelled':
      return 'bg-destructive/20 text-destructive'
    case 'ArmClaimed':
      return 'bg-success/20 text-success'
    case 'RefundClaimed':
      return 'bg-warning/20 text-warning'
    case 'ProceedsWithdrawn':
    case 'UnallocatedArmWithdrawn':
      return 'bg-accent/20 text-accent'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

/** Safe address truncation — returns "?" if value is missing */
function safeAddr(value: unknown): string {
  return typeof value === 'string' ? truncateAddress(value) : '?'
}

/** Safe bigint conversion — returns 0n if value is missing */
function safeBigInt(value: unknown): bigint {
  if (typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number') {
    try { return BigInt(value) } catch { return 0n }
  }
  return 0n
}

function formatEventArgs(name: string, args: Record<string, unknown>): string {
  try {
    switch (name) {
      case 'SeedAdded':
        return safeAddr(args.seed)
      case 'Invited':
        return `${safeAddr(args.inviter)} -> ${safeAddr(args.invitee)} (hop ${args.hop ?? '?'})`
      case 'Committed': {
        const amt = Number(safeBigInt(args.amount)) / 1e6
        return `${safeAddr(args.participant)} $${amt.toLocaleString()}`
      }
      case 'Finalized': {
        const size = Number(safeBigInt(args.saleSize)) / 1e6
        const refund = args.refundMode ? ' (REFUND)' : ''
        return `Sale: $${size.toLocaleString()}${refund}`
      }
      case 'Cancelled':
        return 'Sale cancelled'
      case 'ArmClaimed': {
        const arm = Number(safeBigInt(args.armAmount)) / 1e18
        return `${safeAddr(args.participant)} ${arm.toLocaleString()} ARM (delegate: ${safeAddr(args.delegate)})`
      }
      case 'RefundClaimed': {
        const amount = Number(safeBigInt(args.usdcAmount)) / 1e6
        return `${safeAddr(args.participant)} $${amount.toLocaleString()}`
      }
      default:
        return JSON.stringify(args)
    }
  } catch {
    return JSON.stringify(args)
  }
}

export function EventLog({ events }: EventLogProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ScrollText className="h-4 w-4" />
          Event Log ({events.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No events yet
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto space-y-1">
            {events.slice(0, 100).map((event, i) => (
              <div key={`${event.transactionHash}-${i}`} className="flex items-start gap-2 text-xs py-1">
                <Badge className={`${eventColor(event.name)} text-xs shrink-0`}>
                  {event.name}
                </Badge>
                <span className="text-muted-foreground font-mono">#{event.blockNumber}</span>
                <span className="truncate">{formatEventArgs(event.name, event.args)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
