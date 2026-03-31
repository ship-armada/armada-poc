// ABOUTME: Maps contract revert reason strings to human-readable error messages.
// ABOUTME: Centralized mapping used by useTransactionFlow and InviteLinkRedemption.

/** Known contract revert reasons → user-facing messages */
const REVERT_MAP: [RegExp, string][] = [
  [/user rejected/i, 'Transaction rejected by user'],
  [/insufficient funds/i, 'Insufficient funds for gas'],
  [/deadline passed/i, 'The commitment deadline has passed.'],
  [/cancelled/i, 'This crowdfund has been cancelled.'],
  [/already finalized/i, 'This crowdfund has already been finalized.'],
  [/ARM not loaded/i, 'The crowdfund has not opened yet.'],
  [/not active/i, 'Crowdfund is not in the active phase.'],
  [/not active window/i, 'Commitment window is not open.'],
  [/below minimum/i, 'Amount is below the minimum commitment.'],
  [/not whitelisted/i, 'You are not invited to this hop level.'],
  [/invalid hop/i, 'You are not invited to this hop level.'],
  [/already claimed/i, 'You have already claimed this.'],
  [/claim expired/i, 'The 3-year claim deadline has passed.'],
  [/refundMode/i, 'No ARM allocations (refund mode). Use Claim Refund instead.'],
  [/invalid signature/i, 'This invite link has an invalid signature.'],
  [/nonce consumed/i, 'This invite link has already been used.'],
  [/nonce revoked/i, 'This invite link has been revoked.'],
  [/no invites remaining/i, 'The inviter has no remaining invite slots at this hop.'],
  [/insufficient balance/i, 'Your USDC balance is insufficient.'],
]

/**
 * Map a contract error to a human-readable message.
 * Falls back to the raw message (truncated) if no match is found.
 */
export function mapRevertToMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)

  for (const [pattern, friendly] of REVERT_MAP) {
    if (pattern.test(msg)) return friendly
  }

  // Truncate long error messages
  if (msg.length > 200) return msg.slice(0, 200) + '...'
  return msg
}
