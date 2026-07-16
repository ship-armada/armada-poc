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

/**
 * Whether an invitee is at the invite-stacking cap for a hop. Every
 * `commitWithInvite` stacks another invite onto the invitee (`invitesReceived`
 * +1), which the contract rejects once the invitee is already at the hop's
 * `maxInvitesReceived` ("max invites received"). A first-time invitee has 0
 * received and is never at the cap. `maxInvitesReceived <= 0` (unknown / no cap,
 * e.g. an out-of-range hop) is treated as "not at cap" so we never block on a
 * missing config.
 */
export function isAtInviteCap(
  currentInvitesReceived: number,
  maxInvitesReceived: number,
): boolean {
  return maxInvitesReceived > 0 && currentInvitesReceived >= maxInvitesReceived
}
