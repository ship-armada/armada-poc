// ABOUTME: Pure helper for a redeemer's effective commit cap on the /invite flow.
// ABOUTME: Mirrors the contract's invitesReceived-scaled cap so input isn't clamped below capacity.

/**
 * Effective USDC cap for a redeemer at the target hop after redeeming this
 * invite. The contract bumps `invitesReceived` to `current + 1` on commit and
 * scales the cap by it, so the cap for THIS commit is
 * `(currentInvitesReceived + 1) * perSlotCapUsdc`.
 */
export function effectiveInviteCapUsdc(
  currentInvitesReceived: number,
  perSlotCapUsdc: bigint,
): bigint {
  const multiplier = BigInt(Math.max(0, currentInvitesReceived) + 1)
  return multiplier * perSlotCapUsdc
}
