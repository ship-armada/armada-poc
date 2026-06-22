// ABOUTME: Shared catch-handler for relayer-mediated submits — emits rejected telemetry and recovers
// ABOUTME: a DUPLICATE_TX (already-broadcast) hash so the handler resumes polling instead of failing (T-M3/S-M1).

import { RelayerError, extractDuplicateTxHash, type RelayResponse } from '../relayer'
import { track } from '../telemetry'
import type { TxKind } from './types'

/**
 * Handle an error thrown by `submitRelay` inside a handler's submit stage.
 *
 * - Non-RelayerError → rethrow unchanged.
 * - RelayerError → emit `tx.relayer.rejected`, then:
 *     - DUPLICATE_TX carrying an already-broadcast hash (the relayer dedup cache reports it) →
 *       return it as a pending RelayResponse so the caller persists the hash + resumes polling,
 *       instead of failing a tx that's actually on-chain (T-M3/S-M1).
 *     - anything else → rethrow so the outer catch classifies it (S-H2).
 *
 * Returning a value (rather than the handler branching inline) keeps the recovery identical across
 * all seven relayer-submit handlers.
 */
export function handleRelaySubmitError(
  err: unknown,
  telem: { id: string; kind: TxKind },
): RelayResponse {
  if (err instanceof RelayerError) {
    track('tx.relayer.rejected', { id: telem.id, kind: telem.kind, errorCode: err.code })
    const recovered = extractDuplicateTxHash(err)
    if (recovered) {
      track('tx.relayer.dup-recovered', { id: telem.id, kind: telem.kind })
      return { txHash: recovered, status: 'pending' }
    }
  }
  throw err
}
