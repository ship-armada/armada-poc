// ABOUTME: TelemetrySink handed to the @armada/sdk read instance — forwards the SDK's operational
// ABOUTME: events (currently the quick-sync outcome) onto the interface's typed track() as sdk.quicksync.

import type { TelemetrySink } from '@armada/sdk'
import { track } from '../telemetry'

/**
 * The sink passed to `createArmadaSdk`. Maps the SDK's `sync.quicksync` event → `track('sdk.quicksync')`
 * so an operator can confirm a configured indexer (watcher) is actually serving a root-verified batch,
 * vs lagging into an RPC tail (`served` + `tailCovered`) or being rejected (`root-mismatch-fallback`).
 * Emitted only when an indexer is configured — an RPC-only sync produces nothing. Unknown SDK events
 * are ignored. SPEC §8: the SDK guarantees these payloads carry no key material / addresses / plaintext.
 */
export const sdkTelemetrySink: TelemetrySink = {
  emit(event, data) {
    if (event !== 'sync.quicksync') return
    const outcome = data.outcome
    if (outcome !== 'served' && outcome !== 'root-mismatch-fallback') return
    track('sdk.quicksync', {
      outcome,
      fromBlock: Number(data.fromBlock),
      head: Number(data.head),
      tailCovered: data.tailCovered === true,
    })
  },
}
