// ABOUTME: Shared cross-stack error predicates so network-switch, the tx error classifier, and enrollment copy all agree on what "the user declined" looks like.
// ABOUTME: One source of truth — previously each layer carried its own near-identical copy.

/**
 * Detect user-declined-wallet-prompt errors across wallet stacks. viem throws
 * `UserRejectedRequestError` (code 4001); MetaMask surfaces 4001 or a plain Error with
 * "user rejected / denied / cancelled" in the message; some wrap the underlying error in `.cause`.
 * False positives are harmless — callers show a friendly "you declined" message either way.
 */
export function isUserRejection(err: unknown): boolean {
  if (!err) return false
  const e = err as { code?: number | string; name?: string; message?: string; cause?: unknown }
  if (e.code === 4001 || e.code === 'ACTION_REJECTED') return true
  if (e.name === 'UserRejectedRequestError') return true
  const msg = e.message ?? ''
  if (/user (rejected|denied|cancelled)/i.test(msg)) return true
  if (e.cause && e.cause !== err) return isUserRejection(e.cause)
  return false
}

/**
 * Detect viem's `ChainMismatchError`. viem/wagmi throw this when an action is given an explicit
 * `chainId` that doesn't match the connected wallet's current chain. We pin `chainId` on every
 * submit-path read/write/receipt (W-3/W-4) so a mid-flow network switch surfaces this error
 * instead of silently following the wrong chain; the tx error classifier maps it to actionable
 * "switch back to <network>" copy. Recurses through `.cause` like the rejection predicate.
 */
export function isChainMismatchError(err: unknown): boolean {
  if (!err) return false
  const e = err as { name?: string; cause?: unknown }
  if (e.name === 'ChainMismatchError') return true
  if (e.cause && e.cause !== err) return isChainMismatchError(e.cause)
  return false
}
