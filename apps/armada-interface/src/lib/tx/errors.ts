// ABOUTME: Shared handler-side error classification — converts any thrown value into a typed TxError so markFailed can carry an honest code + optional txHash for the UI to render category-appropriate copy.
// ABOUTME: Handlers' outer try/catch funnels everything through `classifyHandlerError(err)` instead of `err.message` strings, so we never lose the distinction between "tx reverted" / "we lost track" / "user rejected" / "unexpected".

import { extractTxError } from './receipt'
import { isUserRejection } from '../errors'
import { mapRevertToMessage } from '../revert'
import type { TxError } from './types'

/**
 * Convert anything thrown inside a handler into a typed TxError suitable for `markFailed`.
 *
 * Precedence:
 *   1. Branded TxError (thrown by `waitForReceiptOrFail` or a handler that already classified).
 *      Extract as-is so a POLL_TIMEOUT doesn't get re-tagged as OTHER by the outer catch.
 *   2. User-rejected wallet prompt → USER_REJECTED.
 *   3. Anything else → OTHER, preserving the raw message.
 *
 * The optional `sourceTxHash` is folded in for the categories where the UI needs it (timeout,
 * revert) — handlers that have the hash by their catch point should pass it in so the explorer
 * link works. For OTHER / USER_REJECTED it's typically absent and that's fine.
 */
export function classifyHandlerError(
  err: unknown,
  fallbackMessage: string,
  sourceTxHash?: `0x${string}`,
): TxError {
  const branded = extractTxError(err)
  if (branded) {
    // Helper already classified (e.g. POLL_TIMEOUT or TX_REVERTED with its own txHash).
    // Don't overwrite its txHash from the outer context.
    return branded
  }

  if (isUserRejection(err)) {
    return { code: 'USER_REJECTED', message: 'You declined the action in your wallet.' }
  }

  // Run the raw message through mapRevertToMessage: it maps known revert/wallet patterns to short
  // copy and truncates at 200 chars, so a multi-line viem dump (RPC payload, stack frames) doesn't
  // reach ErrorStep verbatim. (P2 — wire the previously-dead mapRevertToMessage.)
  const message = mapRevertToMessage(err instanceof Error ? err.message : fallbackMessage)
  return sourceTxHash ? { code: 'OTHER', message, txHash: sourceTxHash } : { code: 'OTHER', message }
}
