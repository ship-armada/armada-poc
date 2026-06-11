// ABOUTME: Shared transaction-wait timeout policy and timeout detection.
// ABOUTME: A stalled tx must surface as a pending notice, never an infinite spinner or fake success.

/** Max time to wait on a single tx receipt before giving up the wait (ms).
 *  The transaction is NOT cancelled — it may still confirm on-chain — we just
 *  stop blocking the UI on it. */
export const TX_WAIT_TIMEOUT_MS = 120_000

/** User-facing copy when a tx.wait times out. The tx may still land; never
 *  treat a timeout as success and never auto-resubmit. */
export const TX_PENDING_MESSAGE = 'Transaction still pending — check the explorer.'

/**
 * Detect an ethers v6 wait-timeout error (raised by `tx.wait(confirms, timeout)`
 * when the receipt doesn't arrive in time). Distinct from a revert, which has a
 * different code, so callers can show "still pending" rather than "failed".
 */
export function isTxTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ((err as { code?: unknown }).code === 'TIMEOUT') return true
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' && /timeout/i.test(message)
}
