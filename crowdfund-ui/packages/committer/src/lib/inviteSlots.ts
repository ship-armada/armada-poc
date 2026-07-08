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
