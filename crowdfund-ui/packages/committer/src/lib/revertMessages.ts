// ABOUTME: Maps contract revert reason strings to human-readable error messages.
// ABOUTME: Centralized mapping used by useTransactionFlow and InviteLinkRedemption.

/** Known contract revert reasons → user-facing messages */
const REVERT_MAP: [RegExp, string][] = [
  [/user rejected/i, 'Transaction rejected by user'],
  // Pre-broadcast guard from submitWrite/assertHubChain: the wallet is on a
  // non-hub chain. Keep this above the generic patterns so the message survives.
  [/wrong network/i, 'Wrong network — switch to the hub chain in your wallet and retry.'],
  [/insufficient funds/i, 'Insufficient funds for gas'],
  [/deadline passed/i, 'The commitment deadline has passed.'],
  [/cancelled/i, 'This crowdfund has been cancelled.'],
  [/already finalized/i, 'This crowdfund has already been finalized.'],
  [/ARM not loaded/i, 'The crowdfund has not opened yet.'],
  // `not active window` must precede `not active` — the latter is a substring of
  // the former, so the general pattern would otherwise shadow the window-specific one.
  [/not active window/i, 'Commitment window is not open.'],
  [/not active/i, 'Crowdfund is not in the active phase.'],
  [/below minimum/i, 'Amount is below the minimum commitment.'],
  [/not whitelisted/i, 'You are not invited to this hop level.'],
  [/invalid hop/i, 'You are not invited to this hop level.'],
  [/already claimed/i, 'You have already claimed this.'],
  [/claim expired/i, 'The 3-year claim deadline has passed.'],
  [/refund mode/i, 'No ARM allocations (refund mode). Use Claim Refund instead.'],
  [/invalid( invite)? signature/i, 'This invite link has an invalid signature.'],
  [/nonce already used/i, 'This invite link has already been used.'],
  [/nonce consumed/i, 'This invite link has already been used.'],
  [/nonce revoked/i, 'This invite link has been revoked.'],
  [/no invites remaining/i, 'The inviter has no remaining invite slots at this hop.'],
  [/insufficient balance/i, 'Your USDC balance is insufficient.'],
  // Contract revert strings (ArmadaCrowdfund.sol).
  [/window closed/i, 'The commitment window has closed.'],
  [/invite expired/i, 'This invite link has expired.'],
  [/invite limit reached/i, 'The inviter has no remaining invite slots.'],
  [/already whitelisted/i, 'This address is already invited.'],
  [/max invites received/i, "You've already accepted the maximum number of invites for this hop."],
  [/max hop reached/i, 'You are already at the deepest hop level.'],
  // OpenZeppelin ERC20 (USDC) revert strings.
  [/insufficient allowance/i, 'USDC approval is too low — approve and retry.'],
  [/transfer amount exceeds balance/i, 'Your USDC balance is insufficient.'],
  // Generic ethers contract revert with no decodable reason.
  [/missing revert data|execution reverted/i, 'The transaction was reverted by the contract.'],
]

/**
 * Map a contract error to a human-readable message.
 *
 * Falls back to a generic "Transaction failed" rather than leaking the raw
 * error (which can contain calldata hex / internal detail) into the user-facing
 * slot. Callers that want the raw text should surface it separately as
 * `errorDetails`, not as the friendly message.
 */
export function mapRevertToMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // ethers v6 tags contract reverts with a code; treat a bare CALL_EXCEPTION
  // (no decodable reason in the message) as a generic contract revert.
  const code = (err as { code?: unknown } | null)?.code

  for (const [pattern, friendly] of REVERT_MAP) {
    if (pattern.test(msg)) return friendly
  }

  if (code === 'CALL_EXCEPTION') return 'The transaction was reverted by the contract.'

  return 'Transaction failed'
}
