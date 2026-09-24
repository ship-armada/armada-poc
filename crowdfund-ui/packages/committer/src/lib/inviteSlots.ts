// ABOUTME: Pure helpers for invite-slot availability gating.
// ABOUTME: Keeps the bigint comparison (ethers v6 returns bigint) out of the component and testable.

/**
 * Whether an inviter has no remaining invite slots for a hop. `remaining` comes
 * from the contract's `getInvitesRemaining` as a bigint — comparing it against
 * the number literal `0` is always false, so the gate must use `0n`.
 */
export function hasNoInviteSlots(remaining: bigint): boolean {
  return remaining === 0n
}

/**
 * Whether any invite section still has a free (empty) slot — the same
 * condition the invite send path needs. Hop-2 sections carry no slots, so a
 * Hop-2-only wallet (or one that has used every slot) has nothing to invite.
 */
export function hasFreeInviteSlot(
  sections: ReadonlyArray<{ config: { slots: ReadonlyArray<{ status: string }> } }> | undefined,
): boolean {
  return Boolean(
    sections?.some((section) => section.config.slots.some((slot) => slot.status === 'empty')),
  )
}
