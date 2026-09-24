// ABOUTME: Pure builder for invite-slot rows from local links + on-chain truth.
// ABOUTME: On-chain consumption (redemptions + direct invites) takes priority over local pending links.

import type { SlotData } from '@armada/crowdfund-shared'
import { encodeInviteUrl, type StoredInviteLink } from './inviteLinks'

export interface BuildSlotRowsArgs {
  /** invitesReceived * maxInvites for the hop — the total budget of slot rows. */
  totalSlots: number
  /** First slot id for this section (ids run 1..N globally across hops). */
  startId: number
  /** Local links for this hop with status pending or redeemed. */
  activeLinks: StoredInviteLink[]
  /** nonce → redeemer address, from on-chain `Invited` events (nonce > 0). */
  linkRedemptions: Map<number, string>
  /** Invitee addresses from direct on-chain `invite()` calls (nonce === 0). */
  directInvitedAddresses: string[]
  /** Lowercased addresses with a `Committed` event at the invitee hop. A
   *  direct invitee in this set has joined, so their row reads as redeemed. */
  committedInvitees?: ReadonlySet<string>
  /** The connected (inviter) address — used to flag self-invites so the row
   *  reads "self-invited" instead of "invited". Case-insensitive. */
  selfAddress?: string | null
  /** Hop the invitee joins as (inviter hop + 1). Applied to redeemed rows. */
  inviteeHop?: 0 | 1 | 2
}

export interface BuildSlotRowsResult {
  slots: SlotData[]
  /** slotId → the local link occupying it (only for revocable pending rows). */
  linkBySlotId: Map<number, StoredInviteLink>
}

/**
 * Build the visible slot rows for one hop section.
 *
 * Ordering / priority (on-chain consumption is the budget truth, so it wins
 * when slots are scarce):
 *   1. Redeemed rows — every on-chain redemption (matched to a local link OR
 *      cross-device), plus any locally-persisted `redeemed` link not yet in the
 *      event stream.
 *   2. Direct on-chain invites (`onchain-pending`, or `redeemed` once the
 *      invitee has committed at the invitee hop).
 *   3. Pending local links not yet redeemed (`link-active`, revocable).
 *   4. Empty rows padding up to `totalSlots`.
 *
 * Rows beyond `totalSlots` are dropped (on-chain rows are first, so they are
 * never the ones dropped).
 */
export function buildSlotRows(args: BuildSlotRowsArgs): BuildSlotRowsResult {
  const {
    totalSlots,
    startId,
    activeLinks,
    linkRedemptions,
    directInvitedAddresses,
    inviteeHop,
  } = args
  const self = args.selfAddress ? args.selfAddress.toLowerCase() : null
  const isSelf = (addr: string | undefined): boolean =>
    self != null && addr != null && addr.toLowerCase() === self

  const rows: Array<{ slot: Omit<SlotData, 'id'>; link?: StoredInviteLink }> = []
  const redeemedNonces = new Set<number>()

  // `joinedAt` on redeemed rows is the link's creation time (`createdAt`, unix
  // seconds): events carry no timestamps, so the true redemption time isn't
  // available here without an extra block lookup.
  // 1a. On-chain redemptions (have a redeemer address). Stable order by nonce.
  for (const nonce of [...linkRedemptions.keys()].sort((a, b) => a - b)) {
    const redeemedBy = linkRedemptions.get(nonce)
    const matchedLink = activeLinks.find((l) => l.nonce === nonce)
    rows.push({
      slot: {
        status: 'redeemed',
        redeemedBy,
        isSelf: isSelf(redeemedBy),
        inviteeHop,
        joinedAt: matchedLink ? new Date(matchedLink.createdAt * 1000) : undefined,
      },
    })
    redeemedNonces.add(nonce)
  }
  // 1b. Locally-persisted redeemed links not (yet) reflected in the events.
  for (const link of activeLinks) {
    if (link.status === 'redeemed' && !redeemedNonces.has(link.nonce)) {
      rows.push({
        slot: {
          status: 'redeemed',
          inviteeHop,
          joinedAt: new Date(link.createdAt * 1000),
        },
      })
      redeemedNonces.add(link.nonce)
    }
  }

  // 2. Direct on-chain invites.
  // Kept in this position once joined so slot ids stay stable.
  for (const invitedAddress of directInvitedAddresses) {
    if (args.committedInvitees?.has(invitedAddress.toLowerCase())) {
      rows.push({
        slot: {
          status: 'redeemed',
          redeemedBy: invitedAddress,
          isSelf: isSelf(invitedAddress),
          inviteeHop,
        },
      })
    } else {
      rows.push({ slot: { status: 'onchain-pending', invitedAddress, isSelf: isSelf(invitedAddress) } })
    }
  }

  // 3. Pending local links not yet redeemed.
  const pending = activeLinks
    .filter((l) => l.status === 'pending' && !redeemedNonces.has(l.nonce))
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const link of pending) {
    rows.push({
      slot: {
        status: 'link-active',
        link: encodeInviteUrl(link),
        expiresAt: new Date(link.deadline * 1000),
      },
      link,
    })
  }

  const visible = rows.slice(0, Math.max(0, totalSlots))

  const slots: SlotData[] = []
  const linkBySlotId = new Map<number, StoredInviteLink>()
  visible.forEach((row, i) => {
    const id = startId + i
    slots.push({ id, ...row.slot })
    if (row.link) linkBySlotId.set(id, row.link)
  })
  for (let i = visible.length; i < totalSlots; i += 1) {
    slots.push({ id: startId + i, status: 'empty' })
  }

  return { slots, linkBySlotId }
}
