// ABOUTME: Shared handler-side error classification — converts any thrown value into a typed TxError so markFailed can carry an honest code + optional txHash for the UI to render category-appropriate copy.
// ABOUTME: Handlers' outer try/catch funnels everything through `classifyHandlerError(err)` instead of `err.message` strings, so we never lose the distinction between "tx reverted" / "we lost track" / "user rejected" / "unexpected".

import { ArmadaError } from '@armada/sdk'
import { extractTxError } from './receipt'
import { decodeRevertData, extractRevertHex } from './revertSelectors'
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
 * Map an `@armada/sdk` `ArmadaError` (the typed spend/prove/sync taxonomy) to a TxError. These are
 * thrown by `planTransfer` / `prove` / `buildTransactCalldata` BEFORE anything reaches the wire, so
 * they carry `PRE_FLIGHT_REVERT` semantics ("nothing was sent") unless the code maps to a category
 * with more specific UI handling (fee-quote → FEE_EXPIRED gates off retry; transient → RPC_ERROR).
 *
 * Mapping to the interface's `TxErrorCode` set rather than the raw SDK code keeps the UI's category
 * behaviour (retry gating, explorer-link rendering) intact; the friendly copy is category-appropriate.
 * Unknown/future SDK codes fall through to OTHER with the SDK's own (truncated) message, so a new
 * error class is surfaced honestly rather than swallowed.
 */
function classifySdkError(err: unknown): TxError | null {
  if (!(err instanceof ArmadaError)) return null
  switch (err.code) {
    case 'ROOT_MISMATCH':
      return {
        code: 'PRE_FLIGHT_REVERT',
        message:
          "Your wallet's view of the shielded pool is out of date (the tree moved on-chain). Wait for sync to finish, then try again.",
      }
    case 'NOTE_ALREADY_SPENT':
      return {
        code: 'PRE_FLIGHT_REVERT',
        message: 'One of the notes selected for this transaction was already spent. Refresh your balance and try again.',
      }
    case 'INSUFFICIENT_BALANCE':
      return { code: 'PRE_FLIGHT_REVERT', message: 'Insufficient shielded balance for this transaction.' }
    case 'NO_SPEND_CAPABILITY':
      return {
        code: 'PRE_FLIGHT_REVERT',
        message: "This wallet is unlocked in view-only mode and can't spend. Unlock with your signature to send.",
      }
    case 'UNSUPPORTED_CIRCUIT_SHAPE':
      return {
        code: 'PRE_FLIGHT_REVERT',
        message: "This transaction's shape isn't supported by the available circuits.",
      }
    case 'ARTIFACT_INTEGRITY':
      return {
        code: 'PRE_FLIGHT_REVERT',
        message: "The proving artifacts failed an integrity check and weren't used. Reload the app to re-fetch them.",
      }
    case 'PROOF_VERIFICATION':
      return {
        code: 'PRE_FLIGHT_REVERT',
        message: 'The zero-knowledge proof failed local verification and was not submitted. Please try again.',
      }
    case 'PROOF_EXPIRED':
    case 'PROOF_HANDLE_INVALIDATED':
      return {
        code: 'PRE_FLIGHT_REVERT',
        message: 'The proof went stale before it could be submitted (the pool state changed). Please try again.',
      }
    case 'INVALID_REQUEST':
      return { code: 'PRE_FLIGHT_REVERT', message: "The transaction request was invalid and wasn't submitted." }
    case 'FEE_QUOTE_EXPIRED':
      return {
        code: 'FEE_EXPIRED',
        message:
          'Your fee quote expired before the transaction was built. Start a new transaction to get a fresh quote.',
      }
    case 'STORAGE_CONFLICT':
      return { code: 'RPC_ERROR', message: 'A local storage conflict interrupted the operation. Please try again.' }
    case 'QUICK_SYNC_SCHEMA':
      return {
        code: 'RPC_ERROR',
        message: 'The sync service returned data in an unexpected format. Please try again shortly.',
      }
    case 'ABORTED':
      // Defensive: the handler's `ctx.signal.aborted` return normally beats this to the punch.
      return { code: 'CANCELLED', message: 'The operation was cancelled.' }
    default:
      // INVALID_KEY_MATERIAL / NON_DETERMINISTIC_SIGNER / CLAIM_SEED_COUNTER / SIGNER_CONTRACT_VIOLATION
      // and any future ArmadaError — surface the SDK message honestly rather than swallow it.
      return { code: 'OTHER', message: mapRevertToMessage(err.message) }
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

  // @armada/sdk spend/prove errors carry a typed code too — map them before OTHER flattens the
  // (often opaque) SDK message into "Something went wrong".
  const sdk = classifySdkError(err)
  if (sdk) return sdk

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

  // S-L1: if the error carries a raw revert payload (0x<selector>…), decode the Solidity-standard
  // Error(string) / Panic(uint256) before they reach ErrorStep as an opaque hex blob. A decoded
  // reason still runs through mapRevertToMessage so known patterns ("insufficient balance") map to
  // friendly copy; an unknown custom-error selector decodes to null and we fall back to the message.
  const revertHex = extractRevertHex(err)
  const decoded = revertHex ? decodeRevertData(revertHex) : null

  // Run the raw (or decoded) message through mapRevertToMessage: it maps known revert/wallet
  // patterns to short copy and truncates at 200 chars, so a multi-line viem dump (RPC payload,
  // stack frames) doesn't reach ErrorStep verbatim. (P2 — wire the previously-dead mapRevertToMessage.)
  const raw = decoded ?? (err instanceof Error ? err.message : fallbackMessage)
  const message = mapRevertToMessage(raw)
  return sourceTxHash ? { code: 'OTHER', message, txHash: sourceTxHash } : { code: 'OTHER', message }
}
