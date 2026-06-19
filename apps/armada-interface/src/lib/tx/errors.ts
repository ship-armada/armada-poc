// ABOUTME: Shared handler-side error classification — converts any thrown value into a typed TxError so markFailed can carry an honest code + optional txHash for the UI to render category-appropriate copy.
// ABOUTME: Handlers' outer try/catch funnels everything through `classifyHandlerError(err)` instead of `err.message` strings, so we never lose the distinction between "tx reverted" / "we lost track" / "user rejected" / "unexpected".

import { extractTxError } from './receipt'
import { isUserRejection, isChainMismatchError } from '../errors'
import { mapRevertToMessage } from '../revert'
import { getChainById } from '@/config/network'
import type { TxError } from './types'
import type { RelayerErrorCode } from '@/config/relayer'

/** Duck-typed `RelayerError` (lib/relayer.ts) — matched structurally to avoid importing the whole
 *  HTTP client (and any cycle) into the tx-error path. */
function asRelayerError(
  err: unknown,
): { code: RelayerErrorCode; message: string } | null {
  const code = (err as { code?: unknown }).code
  if (err instanceof Error && err.name === 'RelayerError' && typeof code === 'string') {
    return { code: code as RelayerErrorCode, message: err.message }
  }
  return null
}

/**
 * Map a relayer rejection to a typed TxError. The relayer carries a rich code set that the generic
 * OTHER path would otherwise flatten to "Something went wrong" (S-H2):
 *   - pre-broadcast refusals (gas estimation / invalid target/chain/data) → PRE_FLIGHT_REVERT
 *     ("nothing was sent").
 *   - fee-quote rejections → FEE_EXPIRED (retry is futile — S-H1 gates it off; start over).
 *   - DUPLICATE_TX (409) → the tx WAS submitted; recover the hash + resume (T-M3) rather than fail.
 *   - busy / submission hiccup → RPC_ERROR (transient, retry-appropriate).
 */
function classifyRelayerError(err: unknown): TxError | null {
  const re = asRelayerError(err)
  if (!re) return null
  const message = mapRevertToMessage(re.message)
  switch (re.code) {
    case 'GAS_ESTIMATION_FAILED':
    case 'INVALID_TARGET':
    case 'INVALID_CHAIN':
    case 'INVALID_DATA':
      return { code: 'PRE_FLIGHT_REVERT', message }
    case 'FEE_TOO_LOW':
    case 'FEE_EXPIRED':
    case 'FEE_INSUFFICIENT':
      return {
        code: 'FEE_EXPIRED',
        message:
          'Your fee quote expired before the relayer accepted the transaction. Start a new transaction to get a fresh quote.',
      }
    case 'DUPLICATE_TX':
      return { code: 'DUPLICATE_TX', message: 'This transaction was already submitted to the relayer.' }
    case 'RELAYER_BUSY':
    case 'SUBMISSION_FAILED':
      return { code: 'RPC_ERROR', message }
    case 'UNKNOWN_ERROR':
    default:
      return { code: 'OTHER', message }
  }
}

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
 *
 * The optional `targetChainId` lets a chain-mismatch error name the network the wallet should be
 * on ("switch back to <network>"). Handlers pass the chain their pinned calls target (W-4).
 */
export function classifyHandlerError(
  err: unknown,
  fallbackMessage: string,
  sourceTxHash?: `0x${string}`,
  targetChainId?: number,
): TxError {
  const branded = extractTxError(err)
  if (branded) {
    // Helper already classified (e.g. POLL_TIMEOUT or TX_REVERTED with its own txHash).
    // Don't overwrite its txHash from the outer context.
    return branded
  }

  // Relayer rejections carry a typed code — map it before the OTHER fallback flattens it (S-H2).
  const relayer = classifyRelayerError(err)
  if (relayer) return relayer

  // Chain-mismatch: a pinned-chainId call hit a wallet that switched networks mid-flow (W-3/W-4).
  // Nothing was broadcast and retry is safe once the user switches back, so RPC_ERROR semantics
  // fit; the copy is actionable rather than the raw viem dump the OTHER fallback would surface.
  if (isChainMismatchError(err)) {
    const label =
      targetChainId !== undefined ? getChainById(targetChainId)?.name ?? `chain ${targetChainId}` : null
    return {
      code: 'RPC_ERROR',
      message: label
        ? `Your wallet is on the wrong network. Switch back to ${label} and try again.`
        : 'Your wallet is on the wrong network for this transaction. Switch your wallet back to the correct network and try again.',
    }
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
