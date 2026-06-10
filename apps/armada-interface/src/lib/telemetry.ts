// ABOUTME: Structured console-only telemetry — typed event registry (compile-time privacy enforcement) + scoped error reporter.
// ABOUTME: Plan §16 + reviewer #12. Never emit amounts, recipients, mnemonics, attestation bytes, addresses, memo fields.

import type { TxKind, TxRecord, TxStage } from './tx/types'

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

/**
 * Caught error — pass a stable scope tag + the raw error. Props are
 * primitives only (`ErrorProps`) so an accidental object dump doesn't slip
 * sensitive data through.
 */
export function trackError(scope: string, err: unknown, props: ErrorProps = {}): void {
  const message = err instanceof Error ? err.message : String(err)
  emit('error', 'error', { scope, message, ...props })
}
