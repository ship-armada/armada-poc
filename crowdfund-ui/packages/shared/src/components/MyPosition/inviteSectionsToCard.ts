// ABOUTME: Adapts CrowdfundInviteSlotSection[] into InvitesCard allowance + hop handlers.
// ABOUTME: Live committer sections stay slot-id based; the card speaks invitee-hop.

import type { SlotData } from '../InviteFlow/screens/SlotCard'
import type { InviteAllowance, InviteeHop } from './inviteModel'

/** Minimal section shape used by InvitesCard wiring (matches CrowdfundInviteSlotSection). */
export interface InviteSectionLike {
  hop: 0 | 1 | 2
  totalSlots: number
  config: {
    slots: SlotData[]
    onGenerateLink: (slotId: number) => Promise<void> | Promise<unknown>
    onRevoke: (slotId: number) => void
    /** Resolves true only once the invite is confirmed on-chain. */
    onInviteOnchain: (
      slotId: number,
      address: string,
      ensName?: string,
    ) => Promise<boolean>
    isWrongNetwork?: boolean
    onSwitchNetwork?: () => void
  }
}

/** Inviter hop → invitee hop. Hop-2 cannot invite further. */
function inviteeHopFromSection(sectionHop: 0 | 1 | 2): InviteeHop | null {
  if (sectionHop === 0) return 1
  if (sectionHop === 1) return 2
  return null
}

export function allowanceFromInviteSections(
  sections: ReadonlyArray<InviteSectionLike>,
): InviteAllowance {
  let hop1 = 0
  let hop2 = 0
  for (const section of sections) {
    const invitee = inviteeHopFromSection(section.hop)
    if (invitee === 1) hop1 += section.totalSlots
    if (invitee === 2) hop2 += section.totalSlots
  }
  return { hop1, hop2 }
}

/** Non-empty slot rows across sections, tagged with inviteeHop when missing. */
export function issuedSlotsFromInviteSections(
  sections: ReadonlyArray<InviteSectionLike>,
): SlotData[] {
  const out: SlotData[] = []
  for (const section of sections) {
    const invitee = inviteeHopFromSection(section.hop)
    for (const slot of section.config.slots) {
      if (slot.status === 'empty') continue
      out.push({
        ...slot,
        inviteeHop: slot.inviteeHop ?? invitee ?? undefined,
      })
    }
  }
  return out
}

export function sectionForInviteeHop(
  sections: ReadonlyArray<InviteSectionLike>,
  inviteeHop: InviteeHop,
): InviteSectionLike | undefined {
  const fromHop = (inviteeHop - 1) as 0 | 1 | 2
  return sections.find((section) => section.hop === fromHop)
}

export function firstEmptySlotId(section: InviteSectionLike): number | null {
  const empty = section.config.slots.find((slot) => slot.status === 'empty')
  return empty?.id ?? null
}

/**
 * Revoke the invite link with this URL through the section that currently
 * holds it. Resolves by URL (unique per link nonce) rather than a slot id a
 * caller captured earlier: live rows re-sort as on-chain invites land, so a
 * stale slot id can point at a different pending link. Returns false (and
 * revokes nothing) when no section holds the link.
 */
export function revokeLinkViaSections(
  sections: ReadonlyArray<InviteSectionLike>,
  link: string,
): boolean {
  for (const section of sections) {
    const slot = section.config.slots.find((s) => s.link === link)
    if (slot) {
      section.config.onRevoke(slot.id)
      return true
    }
  }
  return false
}

/**
 * Send an on-chain invite through the section that feeds `inviteeHop`.
 * Resolves with the created invite only when the section confirms it was sent;
 * undefined when nothing was sent (wrong network, no empty slot, rejected,
 * reverted, or still pending) so callers never show a false success.
 *
 * `onBeforeSend` receives the slot id just before the send starts. The
 * section can surface the new row (e.g. from receipt logs) before the send
 * resolves, so callers that defer showing it must hide it here, not after.
 */
export async function inviteOnchainViaSections(
  sections: ReadonlyArray<InviteSectionLike>,
  inviteeHop: InviteeHop,
  address: string,
  ensName?: string,
  onBeforeSend?: (slotId: number) => void,
): Promise<{ id: number; address: string; ensName?: string } | undefined> {
  const section = sectionForInviteeHop(sections, inviteeHop)
  if (!section) return undefined
  if (section.config.isWrongNetwork) {
    section.config.onSwitchNetwork?.()
    return undefined
  }
  const emptyId = firstEmptySlotId(section)
  if (emptyId == null) return undefined
  onBeforeSend?.(emptyId)
  const sent = await section.config.onInviteOnchain(emptyId, address, ensName)
  if (!sent) return undefined
  return { id: emptyId, address, ensName }
}
