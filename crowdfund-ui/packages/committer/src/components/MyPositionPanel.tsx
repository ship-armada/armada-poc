// ABOUTME: Dashboard surface for the connected wallet — summary stats, subtree, invitees, activity.
// ABOUTME: Pure read-only; routes to the Participate / Network / Claim pages via callbacks.

import { useMemo } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock,
  Copy,
  Send,
  UserPlus,
} from 'lucide-react'
import {
  Button,
  cn,
  formatUsdc,
  formatCountdown,
  hopLabel,
  truncateAddress,
  type CrowdfundEvent,
  type CrowdfundGraph,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'

export interface MyPositionPanelProps {
  address: string
  positions: HopPosition[]
  totalCommitted: bigint
  graph: CrowdfundGraph
  events: CrowdfundEvent[]
  resolveENS: (addr: string) => string | null
  /** True when the Claim page is actionable. */
  claimAvailable: boolean
  /** Seconds until claim opens, when not yet open. Falsy ⇒ no countdown. */
  claimCountdown?: number
  onGoToInvite: () => void
  onGoToNetwork: () => void
  onGoToClaim: () => void
}

interface InviteeRow {
  address: string
  hop: number
  committed: bigint
}

type ActivityItem =
  | { kind: 'commit'; amount: bigint; hop: number; blockNumber: number; txHash: string }
  | { kind: 'invite-out'; target: string; hop: number; blockNumber: number; txHash: string }
  | { kind: 'invite-in'; source: string; hop: number; blockNumber: number; txHash: string }

const HOP_COLORS = ['var(--hop-0)', 'var(--hop-1)', 'var(--hop-2)']

/** Tiny SVG showing the user as a centered node and invitees on a ring,
 *  coloured by hop. Pure visual — for clickable interaction users use the
 *  full Network page (linked from the panel). */
function SubtreeMini({
  invitees,
}: {
  invitees: InviteeRow[]
}) {
  const size = 180
  const center = size / 2
  const radius = 60
  const count = invitees.length
  const placedDots = useMemo(() => {
    if (count === 0) return []
    return invitees.slice(0, 16).map((inv, i) => {
      const total = Math.min(invitees.length, 16)
      const angle = (2 * Math.PI * i) / total - Math.PI / 2
      const x = center + radius * Math.cos(angle)
      const y = center + radius * Math.sin(angle)
      const color = HOP_COLORS[inv.hop] ?? HOP_COLORS[2]
      return { x, y, color, address: inv.address }
    })
  }, [invitees, count, center])

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="mx-auto"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="mp-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* Halo */}
      <circle cx={center} cy={center} r={radius + 18} fill="url(#mp-glow)" />
      {/* Edges from center to each dot */}
      {placedDots.map((d, i) => (
        <line
          key={`e-${i}`}
          x1={center}
          y1={center}
          x2={d.x}
          y2={d.y}
          stroke="var(--graph-edge)"
          strokeOpacity={0.4}
          strokeWidth={1}
        />
      ))}
      {/* Invitee dots */}
      {placedDots.map((d, i) => (
        <circle
          key={`d-${i}`}
          cx={d.x}
          cy={d.y}
          r={5}
          fill={d.color}
          fillOpacity={0.7}
          stroke={d.color}
          strokeWidth={1}
        />
      ))}
      {/* Center "you" marker */}
      <circle
        cx={center}
        cy={center}
        r={11}
        fill="var(--primary)"
        fillOpacity={0.18}
        stroke="var(--primary)"
        strokeWidth={1.5}
      />
      <text
        x={center}
        y={center + 4}
        textAnchor="middle"
        fontFamily="var(--font-family-heading)"
        fontSize={11}
        fontWeight={600}
        fill="var(--foreground)"
      >
        You
      </text>
    </svg>
  )
}

/** Compact stat tile for the top-row summary. */
function StatTile({
  label,
  value,
  hint,
}: {
  label: string
  value: string | number
  hint?: string
}) {
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-3">
      <div className="font-heading text-xl font-semibold tabular-nums text-foreground">
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** Section card chrome. Mockup uses a "Your X" heading + content body. */
function Section({
  title,
  children,
  className,
}: {
  title: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card p-4 shadow-elevated',
        className,
      )}
    >
      <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  )
}

export function MyPositionPanel(props: MyPositionPanelProps) {
  const {
    address,
    positions,
    totalCommitted,
    graph,
    events,
    resolveENS,
    claimAvailable,
    claimCountdown,
    onGoToInvite,
    onGoToNetwork,
    onGoToClaim,
  } = props

  const lowerAddress = address.toLowerCase()

  const invitesRemaining = positions.reduce((s, p) => s + p.invitesAvailable, 0)
  const totalSlots = positions.reduce(
    (s, p) => s + p.invitesUsed + p.invitesAvailable,
    0,
  )

  // Best "level" to summarize: the lowest hop the user holds a slot in.
  const userLevel = useMemo(() => {
    if (positions.length === 0) return null
    return positions.reduce((min, p) => (p.hop < min ? p.hop : min), positions[0].hop)
  }, [positions])

  // Invitees: anyone whose `invitedBy` includes our address.
  const invitees = useMemo<InviteeRow[]>(() => {
    const seen = new Set<string>()
    const list: InviteeRow[] = []
    for (const node of graph.nodes.values()) {
      if (!node.invitedBy.some((i) => i.toLowerCase() === lowerAddress)) continue
      if (node.address.toLowerCase() === lowerAddress) continue // skip self-invites
      const key = `${node.address.toLowerCase()}-${node.hop}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push({
        address: node.address,
        hop: node.hop,
        committed: node.committed,
      })
    }
    // Most-active first
    list.sort((a, b) => (a.committed > b.committed ? -1 : a.committed < b.committed ? 1 : 0))
    return list
  }, [graph.nodes, lowerAddress])

  const inviteesCommitted = invitees.reduce((s, i) => s + i.committed, 0n)

  // Activity feed: events involving this wallet, newest first, capped.
  const activity = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = []
    for (const e of events) {
      if (e.type === 'Committed') {
        const participant = String(e.args.participant ?? '').toLowerCase()
        if (participant !== lowerAddress) continue
        items.push({
          kind: 'commit',
          amount: e.args.amount as bigint,
          hop: Number(e.args.hop),
          blockNumber: e.blockNumber,
          txHash: e.transactionHash,
        })
      } else if (e.type === 'Invited' || e.type === 'LaunchTeamInvited') {
        const inviter = String(e.args.inviter ?? '').toLowerCase()
        const invitee = String(e.args.invitee ?? '').toLowerCase()
        const hop = Number(e.args.hop)
        if (inviter === lowerAddress) {
          items.push({
            kind: 'invite-out',
            target: String(e.args.invitee),
            hop,
            blockNumber: e.blockNumber,
            txHash: e.transactionHash,
          })
        } else if (invitee === lowerAddress) {
          items.push({
            kind: 'invite-in',
            source: String(e.args.inviter),
            hop,
            blockNumber: e.blockNumber,
            txHash: e.transactionHash,
          })
        }
      }
    }
    // Newest first by block number, stable for ties.
    items.sort((a, b) => b.blockNumber - a.blockNumber)
    return items.slice(0, 8)
  }, [events, lowerAddress])

  const renderInviteeName = (addr: string) =>
    resolveENS(addr) ?? truncateAddress(addr)

  return (
    <div className="space-y-3">
      {/* ── Your Summary — top row ───────────────────────────────────── */}
      <Section title="Your Summary">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile label="Committed" value={formatUsdc(totalCommitted)} />
          <StatTile
            label="Invites Remaining"
            value={invitesRemaining}
            hint={
              totalSlots > 0
                ? `${totalSlots - invitesRemaining}/${totalSlots} used`
                : undefined
            }
          />
          <StatTile
            label="Your Level"
            value={userLevel !== null ? hopLabel(userLevel) : '—'}
            hint={
              positions.length > 1
                ? `Across ${positions.length} positions`
                : undefined
            }
          />
        </div>
      </Section>

      {/* ── Claim status banner ───────────────────────────────────────── */}
      <Section
        title="Claim status"
        className={
          claimAvailable
            ? 'border-success/50 bg-success/5'
            : undefined
        }
      >
        {claimAvailable ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">
                Claim is open
              </div>
              <div className="text-xs text-muted-foreground">
                You can now claim your ARM tokens (or USDC refund).
              </div>
            </div>
            <Button size="sm" onClick={onGoToClaim}>
              Claim now
              <ArrowRight className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="flex items-start gap-3 text-sm">
            <Clock
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div>
              <div className="text-foreground">Not yet available</div>
              {claimCountdown !== undefined && claimCountdown > 0 && (
                <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  Available in{' '}
                  <span className="text-foreground">{formatCountdown(claimCountdown)}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* ── Network + Invite CTA — two columns on desktop ─────────────── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Section title="Your Network">
          <div className="flex flex-col items-center gap-3">
            <SubtreeMini invitees={invitees} />
            <div className="text-center text-xs text-muted-foreground tabular-nums">
              <span className="text-foreground font-medium">{invitees.length}</span>{' '}
              invitee{invitees.length === 1 ? '' : 's'}
              {inviteesCommitted > 0n && (
                <>
                  {' '}
                  ·{' '}
                  <span className="text-foreground font-medium">
                    {formatUsdc(inviteesCommitted)}
                  </span>{' '}
                  committed below you
                </>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onGoToNetwork}
            >
              View in network
              <ArrowUpRight className="size-3.5" />
            </Button>
          </div>
        </Section>

        <Section title="Invite Someone">
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Send an invite directly to a wallet, or generate a shareable link the invitee
              redeems on their own.
            </div>
            <div className="rounded-md border border-border/60 bg-card/40 p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Slots remaining</span>
                <span className="font-medium tabular-nums">
                  {invitesRemaining}/{totalSlots}
                </span>
              </div>
            </div>
            <Button
              size="sm"
              className="w-full"
              onClick={onGoToInvite}
              disabled={invitesRemaining === 0}
            >
              <Copy className="size-3.5" />
              Copy invite link
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onGoToInvite}
              disabled={invitesRemaining === 0}
            >
              <UserPlus className="size-3.5" />
              Send direct invite
            </Button>
          </div>
        </Section>
      </div>

      {/* ── Your Invites + Activity — two columns on desktop ──────────── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Section title="Your Invites">
          {invitees.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              You haven't invited anyone yet.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {invitees.slice(0, 6).map((inv) => {
                const joined = inv.committed > 0n
                return (
                  <li
                    key={`${inv.address}-${inv.hop}`}
                    className="flex items-center justify-between rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-foreground">
                        {renderInviteeName(inv.address)}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {hopLabel(inv.hop)}
                        {inv.committed > 0n && (
                          <>
                            {' '}
                            · <span className="tabular-nums">{formatUsdc(inv.committed)}</span>{' '}
                            committed
                          </>
                        )}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
                        joined
                          ? 'border-success/50 bg-success/10 text-success'
                          : 'border-border/60 bg-card/40 text-muted-foreground',
                      )}
                    >
                      {joined ? <Check className="size-3" /> : <Clock className="size-3" />}
                      {joined ? 'Joined' : 'Pending'}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {invitees.length > 6 && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-8 w-full text-xs"
              onClick={onGoToNetwork}
            >
              View all {invitees.length} in network
              <ArrowRight className="size-3" />
            </Button>
          )}
        </Section>

        <Section title="Activity">
          {activity.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Your commits and invites will appear here.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {activity.map((item, i) => {
                if (item.kind === 'commit') {
                  return (
                    <li
                      key={`${item.txHash}-${i}`}
                      className="flex items-center justify-between rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-success/15 text-success">
                          <Check className="size-3" />
                        </span>
                        <span>
                          Committed at{' '}
                          <span className="text-foreground">{hopLabel(item.hop)}</span>
                        </span>
                      </div>
                      <span className="font-medium tabular-nums">
                        +{formatUsdc(item.amount)}
                      </span>
                    </li>
                  )
                }
                if (item.kind === 'invite-out') {
                  return (
                    <li
                      key={`${item.txHash}-${i}`}
                      className="flex items-center justify-between rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-primary">
                          <Send className="size-3" />
                        </span>
                        <span>
                          Invited{' '}
                          <span className="font-mono">{renderInviteeName(item.target)}</span>
                        </span>
                      </div>
                      <span className="text-muted-foreground tabular-nums">
                        {hopLabel(item.hop + 1)}
                      </span>
                    </li>
                  )
                }
                // invite-in
                return (
                  <li
                    key={`${item.txHash}-${i}`}
                    className="flex items-center justify-between rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <UserPlus className="size-3" />
                      </span>
                      <span>
                        Invited by{' '}
                        <span className="font-mono">{renderInviteeName(item.source)}</span>
                      </span>
                    </div>
                    <span className="text-muted-foreground tabular-nums">
                      {hopLabel(item.hop)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {activity.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-8 w-full text-xs"
              onClick={onGoToNetwork}
            >
              View full activity
              <ArrowRight className="size-3" />
            </Button>
          )}
        </Section>
      </div>
    </div>
  )
}
