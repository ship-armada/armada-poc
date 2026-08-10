// ABOUTME: Structured telemetry — typed event registry (compile-time privacy enforcement) + scoped error reporter.
// ABOUTME: Console always; `trackError` also forwards to Sentry (no-op unless a DSN is configured). Plan §16 + reviewer #12. Never emit amounts, recipients, mnemonics, attestation bytes, addresses, memo fields.

import type { TxKind, TxRecord, TxStage } from './tx/types'
import { captureError } from './sentry'

/* ------------------------------------------------------------------ *
 *  EventRegistry — the canonical, allowlisted set of telemetry events.
 *  Adding here is the review surface where privacy mistakes get caught.
 *
 *  RULE: props are non-sensitive identifiers (ids, chain ids, counts,
 *  kinds, transition labels). They MUST NOT contain:
 *    - amounts (bigint values, fee amounts, balance numbers)
 *    - recipients (EVM addresses, 0zk addresses, ENS names)
 *    - mnemonics / passphrases / decrypted key bytes
 *    - tx calldata, attestation bytes, message bytes
 *    - tx hashes that haven't already been resolved to a public block (i.e. emit
 *      txHash only after the receipt is final; never during signing).
 *
 *  Adding a new event = adding a key here and the EXACT shape it carries.
 *  If a contributor wants to log something not in the registry, they EDIT
 *  THIS FILE deliberately. The PR diff is the privacy review.
 * ------------------------------------------------------------------ */

export type EventRegistry = {
  'wallet.connected':         { chainId: number | null }                       // EVM address EXCLUDED
  'wallet.disconnected':      Record<string, never>

  'shielded.created':         { walletId: string }                             // id is fine; mnemonic/keys never
  'shielded.unlock':          { walletId: string }
  'shielded.locked':          { walletId: string }
  'shielded.exported':        { walletId: string }                             // Settings → Export recovery phrase; phrase content NEVER logged
  'shielded.reset':           { walletId: string }                             // Settings → Reset private wallet; id pre-clear so we can trace
  // One-shot schema-version migration on cold boot. `from`/`to` are integers (the schemaVersion
  // tags). Emitted once per cold boot when the local schema is older than the bundled version.
  'shielded.schema-migration': { from: number; to: number }
  // User pressed "Try Again" on a failed initial balance sync. No identifiers — just the action.
  'shielded.syncRetry':       Record<string, never>
  // Watcher quick-sync outcome — one line per hub scan's quick-sync attempt so activation +
  // fallback are observable in dev and prod. Counts + block numbers only (never addresses/amounts).
  //   'served'     — hit the watcher; commitments>0 means events actually flowed
  //   'no-indexer' — VITE_INDEXER_URL unset → engine slow-scans (normal; the B4 fallback)
  //   'fell-back'  — attempted but failed → engine slow-scans (paired with a shielded.quicksync error)
  'shielded.quicksync':       { outcome: 'served' | 'no-indexer' | 'fell-back'; pages?: number; commitments?: number; unshields?: number; nullifiers?: number; throughBlock?: number; reason?: string }

  // @armada/sdk read-instance sync outcome — one line per wallet.sync() so resume-vs-rescan is
  // observable. Named `sdk.*` because this is the in-house SDK; stock-engine / shielded-pool telemetry
  // uses `shielded.*`. We never emit `railgun` in any event name or scope (it would confuse the
  // telemetry stream — see the naming convention). Block numbers + a boolean only. `fromBlock` =
  // the resume point (checkpoint + 1): a low value ≈ deploy block means a cold rescan, a high value
  // means it resumed from the IndexedDB checkpoint. `scanned` false = head hadn't advanced (no work).
  'sdk.sync':                 { fromBlock: number; syncedThrough: number; scanned: boolean }

  // @armada/sdk cross-chain-unshield write-path differential — one line per SDK build+simulate (opt-in
  // VITE_SHADOW_SDK). `simulated` true = the pool's on-chain verifier accepted the SDK-built
  // atomicCrossChainUnshield calldata (the arbiter — a proof-carrying tx can't be byte-compared, and it
  // exercises the adaptParams↔CCTP-args binding #399). Observe-only; retired at the xchain unshield cutover.
  'sdk.xchainUnshieldDiff':   { simulated: boolean }

  'tx.submitted':             { id: string; kind: TxKind }
  'tx.transition':            { id: string; kind: TxKind; from: TxStage; to: TxStage; executionState: TxRecord['executionState'] }
  'tx.failed':                { id: string; kind: TxKind; errorCode?: string }
  'tx.expired':               { id: string; kind: TxKind }
  'tx.cancelled':             { id: string; kind: TxKind }
  'tx.interrupted':           { id: string; kind: TxKind }
  'tx.cancel-all':            { reason: string; count: number }

  // Relayer-mediated submit (Phase A). Fired by handlers that delegate broadcast to the relayer
  // instead of sending from the user's wallet. errorCode on `rejected` is the typed RelayerErrorCode
  // (FEE_EXPIRED / FEE_TOO_LOW / etc.) so dashboards can split out fee-staleness from genuine
  // submission errors. NO tx hashes here — those are emitted via `tx.transition` once the relayer
  // returns a hash + the poller confirms inclusion.
  'tx.relayer.submitted':     { id: string; kind: TxKind }
  'tx.relayer.confirmed':     { id: string; kind: TxKind }
  'tx.relayer.rejected':      { id: string; kind: TxKind; errorCode?: string }
  // A DUPLICATE_TX (409) was recovered: the relayer had already broadcast this tx and reported its
  // hash in the rejection message, so we resume polling on it instead of failing (T-M3/S-M1).
  'tx.relayer.dup-recovered': { id: string; kind: TxKind }
  // Fired when an xchain handler enters runWaitForDelivery with less than the inner-poll floor
  // of lifecycle budget remaining. The handler clamps to a 10s minimum (rather than failing
  // immediately) but a sustained signal here indicates records being created with too little
  // budget headroom — typically a resume-after-crash that landed close to maxDurationMs.
  'tx.budget.tight':          { id: string; kind: TxKind; elapsedMs: number }

  'tx.engine.started':        { isLeader: boolean }
  'tx.engine.no-handler':     { kind: TxKind }

  'tx.history.hydrated':      { count: number }
  // Chain-driven history recovery + incoming-transfer detection (Phase 9). `durationMs` covers
  // the SDK call + mapping; `itemCount` is the raw SDK return size; `recordCount` is what we
  // actually wrote (mapped + non-duplicate). Distinguishes Unknown-heavy chain history from
  // genuinely-empty wallets.
  'tx.history.scan.started':  { walletId: string; fromBlock: number | null }
  'tx.history.scan.completed':{ walletId: string; itemCount: number; recordCount: number; durationMs: number }
  'tx.storage.stale-write':   { id: string; existingSeq: number; incomingSeq: number }

  'config.deployments.loaded':{ chainCount: number }

  'poller.tick':              { scope: string; errorStreak: number }

  'stub':                     { fn: string }
}

export type EventName = keyof EventRegistry

/* ------------------------------------------------------------------ *
 *  Error scopes — looser shape than `track` because error paths are
 *  inherently more open-ended. Still: stick to primitives so an
 *  accidental object dump (`amount: bigint(...)`) doesn't pass through.
 * ------------------------------------------------------------------ */

export type ErrorProps = Record<string, string | number | boolean | undefined | null>

/* ------------------------------------------------------------------ */

function ts(): string {
  return new Date().toISOString()
}

function emit(level: 'info' | 'warn' | 'error', event: string, props: Record<string, unknown>): void {
  const line = { ts: ts(), event, ...props }
  if (level === 'error') console.error('[armada]', line)
  else if (level === 'warn') console.warn('[armada]', line)
  else console.info('[armada]', line)
}

/**
 * Emit a telemetry event. The event name + props shape are enforced at
 * compile time via EventRegistry. Add new events to that registry; do not
 * call this with an arbitrary string.
 */
export function track<E extends EventName>(event: E, props: EventRegistry[E]): void {
  emit('info', event, props as Record<string, unknown>)
}

/** Tx state-machine transition — thin wrapper that emits a `tx.transition`. */
export function trackTxTransition(
  record: TxRecord,
  fromStage: TxStage,
  toStage: TxStage,
): void {
  track('tx.transition', {
    id: record.id,
    kind: record.kind,
    from: fromStage,
    to: toStage,
    executionState: record.executionState,
  })
}

/** Max characters of an error message we retain. See `trackError`. */
const ERROR_MESSAGE_MAX_CHARS = 200

/**
 * Caught error — pass a stable scope tag + the raw error. Props are
 * primitives only (`ErrorProps`) so an accidental object dump doesn't slip
 * sensitive data through.
 *
 * Two sinks with different payloads:
 *  - Console: the message reduced to its first line, capped at 200 chars. SDK / RPC / wallet errors
 *    carry long multi-line payloads (request bodies, calldata, stack-laden strings) that may embed
 *    sensitive material; truncating bounds what we print.
 *  - Sentry (only when a DSN is configured — otherwise a no-op): the FULL error object, so stacks
 *    are useful for triage. The remote-sink leak risk this guards against is handled at that
 *    boundary by `lib/sentry.ts`'s `beforeSend` scrubber (redacts 0zk / EVM addresses + long hex)
 *    plus `sendDefaultPii: false`. Keep the two in lockstep: widen the scrubber before widening
 *    what reaches Sentry.
 */
export function trackError(scope: string, err: unknown, props: ErrorProps = {}): void {
  const raw = err instanceof Error ? err.message : String(err)
  const firstLine = raw.split('\n', 1)[0] ?? ''
  const message =
    firstLine.length > ERROR_MESSAGE_MAX_CHARS
      ? `${firstLine.slice(0, ERROR_MESSAGE_MAX_CHARS)}…`
      : firstLine
  emit('error', 'error', { scope, message, ...props })
  captureError(err, { scope, context: props })
}
