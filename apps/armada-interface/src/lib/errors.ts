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
