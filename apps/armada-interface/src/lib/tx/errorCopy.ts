// ABOUTME: Category-aware copy for a failed/cancelled TxError, shared by the live ErrorStep modal + the ActivityReceipt.
// ABOUTME: Keyed off TxErrorCode so the UI never says "Something went wrong" when we actually know what happened.

import type { TxError, TxErrorCode } from './types'

export interface TxErrorCopy {
  title: string
  body?: string
}

/**
 * Per-code copy. POLL_TIMEOUT / DISMISSED / DUPLICATE_TX phrase "may still complete" (we stopped
 * watching, but the tx could have landed); the definitive failures are unambiguous; USER_REJECTED /
 * CANCELLED make clear nothing was sent.
 */
export const TX_ERROR_COPY: Record<TxErrorCode, TxErrorCopy> = {
  TX_REVERTED: {
    title: 'Transaction failed on chain',
    body: 'The network mined your transaction but the contract reverted. No funds were moved.',
  },
  PRE_FLIGHT_REVERT: {
    // No stock body — falls through to error.message, which carries the actual contract
    // revert reason from the pre-flight simulate.
    title: 'Pre-flight check failed — nothing was sent',
  },
  POLL_TIMEOUT: {
    title: 'Lost track of your transaction',
    body: 'We stopped watching after the time budget elapsed. The transaction may still complete — check the explorer to confirm.',
  },
  RPC_ERROR: {
    title: 'Network error',
    body: 'We hit an error talking to the chain. Try again — your transaction may not have been submitted yet.',
  },
  USER_REJECTED: {
    title: 'Action declined',
    body: 'You declined the prompt in your wallet. Nothing was submitted.',
  },
  INTERRUPTED: {
    title: 'Transaction interrupted',
    body: 'This transaction was interrupted before it was sent — nothing left your wallet. Start a new transaction.',
  },
  FEE_EXPIRED: {
    title: 'Fee quote expired',
    body: 'The quoted fee was no longer valid when the relayer received your transaction. Nothing was sent — start a new transaction to get a fresh quote.',
  },
  DUPLICATE_TX: {
    title: 'Already submitted',
    body: 'The relayer already has this transaction — it may still complete. Check the explorer to confirm.',
  },
  CANCELLED: {
    title: 'Cancelled',
    body: 'No transaction was sent.',
  },
  DISMISSED: {
    title: 'Stopped tracking',
    body: 'You asked us to stop watching this transaction. It may still complete on chain — check the explorer.',
  },
  OTHER: {
    title: 'Something went wrong',
  },
}

/**
 * Resolve title + body for an error. Prefers the category's stock body over the raw `error.message`
 * (which is often technical), falling back to the message when a code has no stock body, then to a
 * bare fallback message (submit-time throws before a record exists).
 */
export function resolveTxErrorCopy(
  error?: TxError | null,
  fallbackMessage?: string,
): TxErrorCopy {
  const copy = error ? TX_ERROR_COPY[error.code] : undefined
  return {
    title: copy?.title ?? 'Something went wrong',
    body: copy?.body ?? error?.message ?? fallbackMessage,
  }
}
