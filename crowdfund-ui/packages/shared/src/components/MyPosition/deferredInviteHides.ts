// ABOUTME: Bookkeeping for invites hidden from the sent list until their create confirmation is dismissed.
// ABOUTME: Keyed by the created invite id, so reveal never depends on which slot id the live row lands at.

import type { SlotData } from '../InviteFlow/screens/SlotCard'

/** What identifies a hidden invite's live row: a link URL or an invitee address. */
export interface DeferredInviteKey {
  link?: string
  address?: string
}

export interface DeferredInviteHides {
  /** Hide the invite created as `id` until `reveal(id)` or `clear()`. */
  hide(id: number, key: DeferredInviteKey): void
  /** Show the invite created as `id` again. */
  reveal(id: number): void
  /** Show a link again regardless of which invite hid it (e.g. once revoked). */
  unhideLink(link: string): void
  /** Show every hidden invite (e.g. when leaving the panel). */
  clear(): void
  /** What identifies the invite created as `id`, while it is still hidden. */
  keyFor(id: number): DeferredInviteKey | undefined
  isHidden(slot: SlotData): boolean
}

export function createDeferredInviteHides(): DeferredInviteHides {
  const keysById = new Map<number, DeferredInviteKey>()
  const links = new Set<string>()
  const addresses = new Set<string>()

  return {
    hide(id, key) {
      const normalized: DeferredInviteKey = {
        link: key.link,
        address: key.address?.toLowerCase(),
      }
      keysById.set(id, normalized)
      if (normalized.link) links.add(normalized.link)
      if (normalized.address) addresses.add(normalized.address)
    },
    reveal(id) {
      const key = keysById.get(id)
      keysById.delete(id)
      if (key?.link) links.delete(key.link)
      if (key?.address) addresses.delete(key.address)
    },
    unhideLink(link) {
      links.delete(link)
    },
    clear() {
      keysById.clear()
      links.clear()
      addresses.clear()
    },
    keyFor(id) {
      return keysById.get(id)
    },
    isHidden(slot) {
      if (slot.link != null && links.has(slot.link)) return true
      return slot.invitedAddress != null && addresses.has(slot.invitedAddress.toLowerCase())
    },
  }
}
