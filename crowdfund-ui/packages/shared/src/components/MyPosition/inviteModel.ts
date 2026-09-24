// ABOUTME: Invite allowance math, list item kinds, sort/filter helpers for Whitelist a friend.

import type { SlotData, SlotStatus } from '../InviteFlow/screens/SlotCard'

/** Hop the invitee joins at (never Hop-0 — inviters issue Hop-1 / Hop-2 only). */
export type InviteeHop = 1 | 2

/** Per-hop invite budget from the user's positions (CROWDFUND.md). */
export type InviteAllowance = {
  hop1: number
  hop2: number
}

export type InviteListKind = 'link-pending' | 'waiting' | 'joined' | 'closed'

export const ALL_INVITE_HOPS: readonly InviteeHop[] = [1, 2]
export const ALL_INVITE_STATUSES: readonly InviteListKind[] = [
  'link-pending',
  'waiting',
  'joined',
  'closed',
]

export const INVITE_STATUS_LABELS: Record<InviteListKind, string> = {
  'link-pending': 'Link pending',
  waiting: 'Waiting to commit',
  joined: 'Joined',
  closed: 'Closed',
}

/** Statuses that consume an invite slot (closed / empty do not). */
const USED_STATUSES: ReadonlySet<SlotStatus> = new Set([
  'link-active',
  'onchain-pending',
  'redeemed',
])

export function totalForHop(allowance: InviteAllowance, hop: InviteeHop): number {
  return hop === 1 ? allowance.hop1 : allowance.hop2
}

export function hopsWithAllowance(allowance: InviteAllowance): InviteeHop[] {
  const hops: InviteeHop[] = []
  if (allowance.hop1 > 0) hops.push(1)
  if (allowance.hop2 > 0) hops.push(2)
  return hops
}

export function usedCountForHop(invites: SlotData[], hop: InviteeHop): number {
  return invites.filter(
    (invite) => invite.inviteeHop === hop && USED_STATUSES.has(invite.status),
  ).length
}

export function availableForHop(
  invites: SlotData[],
  allowance: InviteAllowance,
  hop: InviteeHop,
): number {
  return Math.max(0, totalForHop(allowance, hop) - usedCountForHop(invites, hop))
}

export function inviteListKind(invite: SlotData): InviteListKind | null {
  switch (invite.status) {
    case 'link-active':
      return 'link-pending'
    case 'onchain-pending':
      return 'waiting'
    case 'redeemed':
      return 'joined'
    case 'expired':
    case 'revoked':
      return 'closed'
    default:
      return null
  }
}

const KIND_SORT: Record<InviteListKind, number> = {
  'link-pending': 0,
  waiting: 1,
  joined: 2,
  closed: 3,
}

function sortTimestamp(invite: SlotData): number {
  const date =
    invite.joinedAt ??
    invite.invitedAt ??
    invite.closedAt ??
    invite.expiresAt ??
    null
  return date ? date.getTime() : 0
}

/** Actionable first (pending → waiting → joined → closed), newest within each group. */
export function sortInvites(invites: SlotData[]): SlotData[] {
  return [...invites]
    .filter((invite) => inviteListKind(invite) != null)
    .sort((a, b) => {
      const kindA = inviteListKind(a)!
      const kindB = inviteListKind(b)!
      const byKind = KIND_SORT[kindA] - KIND_SORT[kindB]
      if (byKind !== 0) return byKind
      return sortTimestamp(b) - sortTimestamp(a)
    })
}

export function filterInvites(
  invites: SlotData[],
  statuses?: ReadonlySet<InviteListKind> | null,
): SlotData[] {
  const statusFilterActive =
    statuses != null && statuses.size > 0 && statuses.size < ALL_INVITE_STATUSES.length

  return sortInvites(invites).filter((invite) => {
    if (invite.hideFromList) return false
    const kind = inviteListKind(invite)
    if (kind == null) return false
    if (statusFilterActive && !statuses!.has(kind)) return false
    return true
  })
}

export function inviteStatusFilterActive(
  status: InviteListKind | 'all',
): boolean {
  return status !== 'all'
}

export function formatInviteeHop(hop: InviteeHop): string {
  return hop === 1 ? 'Hop-1' : 'Hop-2'
}

export function formatExpiryDays(date: Date): string {
  const diffDays = Math.ceil((date.getTime() - Date.now()) / 86400000)
  if (diffDays <= 0) return 'Expired'
  if (diffDays === 1) return 'Expires in 1 day'
  return `Expires in ${diffDays} days`
}

export function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function nextInviteId(invites: SlotData[]): number {
  return invites.reduce((max, invite) => Math.max(max, invite.id), 0) + 1
}

/** Hop-0: 3→Hop-1. Each Hop-1 position: +2→Hop-2. Cap Hop-2 at 20. */
export function allowanceFromPositions(opts: {
  isHop0: boolean
  hop1Positions: number
}): InviteAllowance {
  const hop1 = opts.isHop0 ? 3 : 0
  const hop2 = Math.min(20, Math.max(0, opts.hop1Positions) * 2)
  return { hop1, hop2 }
}
