// ABOUTME: Module-scope transaction executor — runs stage handlers outside React lifecycle, owns AbortControllers, leader-elected via navigator.locks.
// ABOUTME: Hooks (useTx) only trigger execution; they never orchestrate. Plan §7a; reviewer rec #2 + #9.

import { getDefaultStore } from 'jotai'
import { track, trackError } from '../telemetry'
import { lifecycleFor } from './lifecycles'
import { markCancelled, markDismissed, markExpired, markFailed, markRetrying } from './reducer'
import { loadAllTx, putTxIfFresh } from './storage'
import { isTerminalState } from './types'
import type { StageFor, TxKind, TxRecord } from './types'
import { txListAtom, upsertTxAtom } from '@/state/tx'
import { tabVisibleAtom } from '@/state/visibility'

const LOCK_NAME = 'armada-tx-executor'

/* ----- Public types ----- */

export interface ExecutorCtx<K extends TxKind = TxKind> {
  /** Aborts when the tx is cancelled or the engine is torn down. */
  signal: AbortSignal
  /** Persist a record update via atom + IDB (OCC enforced). */
  upsert: (record: TxRecord<K>) => Promise<void>
}

export interface StageHandler<K extends TxKind = TxKind> {
  kind: K
  /**
   * Run ONE step of the lifecycle. The handler is responsible for:
   *  - persisting the record's new stage / executionState via `ctx.upsert`
   *  - respecting `ctx.signal` and throwing on abort
   *  - never returning a value (transitions happen via `ctx.upsert`)
   *
   * The executor's chain loop reads the updated record from the atom after
   * `run` returns, and either calls `run` again for the next stage, pauses
   * (if executionState=`waiting`), or terminates (if terminal).
   */
  run(record: TxRecord<K>, ctx: ExecutorCtx<K>): Promise<void>

  /** Stages this handler can resume from on app reload. */
  resumableFrom: ReadonlyArray<StageFor<K>>
}

/* ----- Module state (intentionally module-scope, NOT React-scope) ----- */

const handlers = new Map<TxKind, StageHandler<TxKind>>()
const running = new Map<string, AbortController>()
let isLeader = false
let engineStarted = false
// Wallets we've already run resume for this session — resume is idempotent per (walletId, session)
// so a lock/unlock cycle or a re-render of the resume hook can't double-dispatch.
const resumedWallets = new Set<string>()

/* ----- Public API ----- */

export function registerHandler<K extends TxKind>(handler: StageHandler<K>): void {
  handlers.set(handler.kind, handler as unknown as StageHandler<TxKind>)
}

export function getIsLeader(): boolean {
  return isLeader
}

/** Test-only: force the leader flag. Production leadership is owned by `startEngine` via
 *  `navigator.locks`; jsdom has no locks API, so this lets tests exercise the follower-tab guards
 *  (which a real second tab would hit) deterministically. */
export function __setIsLeaderForTests(value: boolean): void {
  isLeader = value
}

/**
 * Initialise the executor. Idempotent — repeated calls are no-ops.
 *
 * Acquires an exclusive `navigator.locks` lock named `armada-tx-executor`. Only
 * the holder runs handlers + resume logic. Other tabs operate as passive
 * observers (their atoms hydrate from IDB but they don't execute).
 *
 * Fire-and-forget; the caller (App.tsx) does not await.
 */
export function startEngine(): void {
  if (engineStarted) return
  engineStarted = true

  if (typeof navigator === 'undefined' || !navigator.locks) {
    // No Locks API (SSR or ancient browser): assume single-tab leader semantics.
    onBecomeLeader()
    return
  }

  navigator.locks
    .request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) {
        // Another tab holds the lock — we run in follower mode.
        isLeader = false
        track('tx.engine.started', { isLeader: false })
        return // returning releases nothing (we never had the lock)
      }
      onBecomeLeader()
      // Hold the lock for the tab's lifetime. The browser releases it on tab
      // close / navigation; another tab can then acquire it on its next start.
      await new Promise<void>(() => { /* intentional never-resolve */ })
    })
    .catch((err) => {
      trackError('tx.engine.start', err, { scope: 'tx.engine', message: 'navigator.locks.request failed' })
    })
}

/**
 * Spawn execution for an existing tx record (by id). Non-blocking; the engine
 * runs the handler chain in the background.
 *
 * Called from `useTx().submit()` (immediately after persisting the initial
 * record) and from resume-on-reload + retry paths.
 *
 * No-op on follower tabs and when no handler is registered for the kind.
 */
export function executeTx(id: string): void {
  if (!isLeader) return
  if (running.has(id)) return // already in flight; reentrancy guard

  const store = getDefaultStore()
  const record = store.get(txListAtom).find(t => t.id === id)
  if (!record) {
    trackError('tx.executor.execute', new Error('no record'), {
      scope: 'tx.executor',
      message: `executeTx called for unknown id ${id}`,
    })
    return
  }

  const handler = handlers.get(record.kind)
  if (!handler) {
    track('tx.engine.no-handler', { kind: record.kind })
    return
  }

  const controller = new AbortController()
  running.set(id, controller)
  void runHandlerChain(record, handler, controller)
}

/** Error codes whose retry is structurally futile — the proof froze a now-invalid fee quote, or
 *  the tx is already in flight. The only recovery is a fresh transaction (or, for DUPLICATE_TX,
 *  the /status hash-recovery in T-M3). (S-H1) */
const NON_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set(['FEE_EXPIRED', 'DUPLICATE_TX'])

/**
 * Returns true if `record` is in a state we'd allow the user to retry from. Two conditions:
 *  1. The record is terminal but recoverable: `failed`, `expired`, or `cancelled`.
 *  2. The current stage is listed in the lifecycle's `retryableStages` — i.e., the handler can
 *     re-enter it without going through earlier stages that are no longer safe to redo (e.g.,
 *     re-burning shielded UTXOs).
 *
 * Pre-terminal states (`pending`, `active`, `waiting`, `retrying`) aren't "retryable" in this
 * sense — they're already running; the user wants Cancel, not Retry.
 */
export function canRetryTx(record: TxRecord): boolean {
  const isRecoverable = record.executionState === 'failed'
    || record.executionState === 'expired'
    || record.executionState === 'cancelled'
  if (!isRecoverable) return false
  // Some failures can't be fixed by re-running the stage: the proof bakes in a fee quote (cacheId
  // + broadcaster-fee amount) the relayer now rejects, so a retry re-POSTs the same doomed quote
  // forever (FEE_EXPIRED); a 409 means the tx is already in flight (DUPLICATE_TX). Offering Retry
  // here is a guaranteed-failure loop — the only recovery is a fresh transaction. (S-H1)
  if (record.artifacts.error && NON_RETRYABLE_ERROR_CODES.has(record.artifacts.error.code)) {
    return false
  }
  const lifecycle = lifecycleFor(record.kind)
  return (lifecycle.retryableStages as ReadonlyArray<string>).includes(record.stage as string)
}

/**
 * Mark the record as retrying and re-dispatch the handler chain. Returns true if the retry was
 * accepted (record exists, stage is retryable) and dispatched; false if it was refused — callers
 * (e.g. `useTx.retry`) use this to avoid flipping a modal to its progress step on a no-op retry.
 *
 * Safe re-broadcast: WS1.3 made every submit stage idempotent, so re-entering `submit-relayer`
 * with a known `sourceTxHash` resumes the receipt/status wait instead of broadcasting again.
 */
export function retryTx(id: string): boolean {
  const store = getDefaultStore()
  const record = store.get(txListAtom).find(t => t.id === id)
  if (!record) {
    trackError('tx.executor.retry', new Error('no record'), {
      scope: 'tx.executor',
      message: `retryTx called for unknown id ${id}`,
    })
    return false
  }
  if (!getIsLeader()) {
    // Follower tab: executeTx is a no-op here, so marking the record `retrying` would wedge it in
    // a non-terminal state forever — counted by pendingTxsAtom, which makes useAutoLock defer the
    // security lock and keep keys in memory. Refuse before markRetrying. The UI also hides Retry
    // on follower tabs (TxActions); this is the belt-and-suspenders guard. (T-H3)
    trackError('tx.executor.retry', new Error('not leader'), {
      scope: 'tx.executor',
      message: `retry refused on follower tab for ${id}`,
    })
    return false
  }
  if (!canRetryTx(record)) {
    trackError('tx.executor.retry', new Error('not retryable'), {
      scope: 'tx.executor',
      message: `retry rejected: state=${record.executionState} stage=${record.stage} kind=${record.kind}`,
    })
    return false
  }
  const retried = markRetrying(record)
  store.set(upsertTxAtom, retried)
  void putTxIfFresh(retried)
  executeTx(id)
  return true
}

/**
 * Abort the in-flight handler chain for a pre-broadcast tx and mark it `cancelled`. Use this only
 * when the tx hasn't yet produced a `sourceTxHash` — nothing on chain to worry about.
 *
 * For post-broadcast records, the on-chain tx will still run regardless of what we do here, so
 * call `dismissTx` instead — it records that the user knowingly stopped tracking, preserves the
 * txHash for explorer linking, and uses honest copy ("Stopped tracking" not "Cancelled").
 *
 * Internal cleanup paths (auto-lock, tab teardown) can use either depending on whether the record
 * has broadcast. The UI's TxActions component picks the right one based on `sourceTxHash` presence.
 */
export function cancelTx(id: string): void {
  abortAndMark(id, 'cancel')
}

/**
 * Abort tracking of a post-broadcast tx without claiming we cancelled it. Marks the record
 * `cancelled` (execution state) with a DISMISSED error code carrying the source tx hash so the
 * UI can render "Stopped tracking — view on explorer" and the user can recover the tx hash.
 *
 * The on-chain tx will run to completion (or revert) independent of this call.
 */
export function dismissTx(id: string): void {
  abortAndMark(id, 'dismiss')
}

/**
 * Abort + terminalize every in-flight tx. Used on session-teardown triggers like an EVM
 * account switch (`useWallet`): the executor is module-scope, so without this it would keep
 * running a handler bound to the OLD account under the new unlock screen — orphaned wallet
 * prompts, and a gasless permit signed by the wrong signer. Each record routes through
 * `abortAndMark`, so a pre-broadcast record becomes `cancelled` and an already-broadcast one
 * becomes `dismissed` (hash preserved for the explorer). (P1-15)
 *
 * MUST be called while the wallet is still unlocked — the terminal-record persist
 * (`putTxIfFresh`) needs the historyEncryptionKey. Call it BEFORE `lockWallet`.
 */
export function cancelAllRunning(reason: string): void {
  // Snapshot ids first — abortAndMark mutates `running` (deletes each controller) as it goes.
  const ids = [...running.keys()]
  if (ids.length === 0) return
  track('tx.cancel-all', { reason, count: ids.length })
  for (const id of ids) {
    // 'cancel' intent; abortAndMark routes a record that already has a sourceTxHash to dismissed
    // (honest "Stopped tracking" + explorer link) automatically — see WS1.2c.
    abortAndMark(id, 'cancel')
  }
}

/**
 * Drop this tab's resume guard for `walletId`. `resumeForWallet` is idempotent per (walletId,
 * session) via `resumedWallets`; without clearing it on lock, a re-unlock in the SAME session
 * (manual lock → unlock, or account-switch → switch back) would early-return and never re-attach
 * watchers to already-broadcast txs — leaving them un-tracked until a full reload. Lock paths call
 * this alongside `cancelAllRunning`. (T-M1)
 */
export function clearResumed(walletId: string): void {
  resumedWallets.delete(walletId)
}

function abortAndMark(id: string, kind: 'cancel' | 'dismiss'): void {
  const controller = running.get(id)
  if (controller) {
    controller.abort()
    running.delete(id)
  }
  const store = getDefaultStore()
  // Re-read the LATEST record — a broadcast may have raced this abort and just patched the hash.
  const record = store.get(txListAtom).find(t => t.id === id)
  if (!record) return
  // Don't clobber an already-terminal record. OCC accepts the bumped seq, so without this guard
  // a cancel on a completed/failed/expired tx would rewrite its terminal state in atom + IDB.
  if (isTerminalState(record.executionState)) {
    return
  }
  // Honest routing: if the tx already broadcast (we have a sourceTxHash), the on-chain tx runs
  // regardless of what the user clicked — labelling it "Cancelled before submission" would be a
  // lie and would drop the explorer link. Route to dismissed so the hash + "Stopped tracking"
  // copy survive, even when the caller asked to cancel. (P0-3 WS1.2c)
  const hasHash = Boolean((record.artifacts as { sourceTxHash?: `0x${string}` }).sourceTxHash)
  const next = (kind === 'dismiss' || hasHash) ? markDismissed(record) : markCancelled(record)
  store.set(upsertTxAtom, next)
  void putTxIfFresh(next)
  track('tx.cancelled', { id: next.id, kind: next.kind })
}

/* ----- Internals ----- */

function onBecomeLeader(): void {
  isLeader = true
  track('tx.engine.started', { isLeader: true })
  // Resume is NOT kicked here. The leader lock is acquired pre-unlock (from App mount), when no
  // walletId / decryption key is available yet — `loadAllTx` would return []. Resume runs from
  // `useTxResume` once the active wallet unlocks (and only on the leader). See resumeForWallet.
}

/**
 * Resume persisted, non-terminal tx records for `walletId` after an app reload / crash. Called
 * from `useTxResume` on unlock, leader-gated and idempotent per (walletId, session). (P0-2)
 *
 * Reads from IDB directly rather than `txListAtom` because hydration (`useTxHistory`) races this;
 * `upsertTxAtom` is OCC-safe so seeding records here can't regress newer in-memory state.
 *
 * Policy — what we resume is deliberately narrow:
 *  - past the per-kind wall-clock budget → `expired` (now actually reachable; resume used to be
 *    dead code that ran pre-unlock with no walletId and silently did nothing).
 *  - has a `sourceTxHash` → the tx is ON CHAIN; re-attach the watcher (receipt / relayer status /
 *    cross-chain delivery polling). Safe because every submit stage is idempotent (WS1.3): a
 *    re-entry with a known hash never re-broadcasts. This is the ONLY thing we resume.
 *  - otherwise (no hash) → we never confirmed a broadcast: interrupted at build-proof, or at
 *    submit-relayer before the tx hit the wire. Resuming would re-prompt the wallet / re-POST out
 *    of nowhere, so we fail honestly with `INTERRUPTED` ("nothing was sent") rather than resume.
 */
export async function resumeForWallet(walletId: string): Promise<void> {
  if (!isLeader) return
  if (!walletId) return
  if (resumedWallets.has(walletId)) return
  resumedWallets.add(walletId)

  const store = getDefaultStore()
  let records: TxRecord[]
  try {
    records = await loadAllTx(walletId)
  } catch (err) {
    resumedWallets.delete(walletId) // let a later unlock retry
    trackError('tx.executor.resume', err, { scope: 'tx.executor', message: 'loadAllTx failed' })
    return
  }

  for (const record of records) {
    if (isTerminalState(record.executionState)) continue

    if (Date.now() - record.createdAt > lifecycleFor(record.kind).maxDurationMs) {
      const expired = markExpired(record)
      store.set(upsertTxAtom, expired)
      await putTxIfFresh(expired)
      track('tx.expired', { id: expired.id, kind: expired.kind })
      continue
    }

    if ((record.artifacts as { sourceTxHash?: `0x${string}` }).sourceTxHash) {
      // Seed the atom so executeTx() can find the record even if hydration hasn't landed yet.
      store.set(upsertTxAtom, record)
      executeTx(record.id)
      continue
    }

    const failed = markFailed(record, {
      code: 'INTERRUPTED',
      message: 'This transaction was interrupted before it was sent — nothing left your wallet. Start a new transaction.',
    })
    store.set(upsertTxAtom, failed)
    await putTxIfFresh(failed)
    track('tx.interrupted', { id: record.id, kind: record.kind })
  }
}

async function runHandlerChain(
  initial: TxRecord,
  handler: StageHandler<TxKind>,
  controller: AbortController,
): Promise<void> {
  const store = getDefaultStore()
  let current = initial

  try {
    while (!controller.signal.aborted) {
      // Pause when the tab is hidden — even on the leader. Polite to API quotas.
      if (!store.get(tabVisibleAtom)) {
        await waitForVisibility(controller.signal)
        if (controller.signal.aborted) break
      }

      // Terminal? Stop the chain.
      if (isTerminalState(current.executionState)) {
        break
      }

      const ctx: ExecutorCtx = {
        signal: controller.signal,
        upsert: async (rec) => {
          store.set(upsertTxAtom, rec)
          await putTxIfFresh(rec)
        },
      }

      await handler.run(current as TxRecord<TxKind>, ctx as ExecutorCtx<TxKind>)

      // Reload current state from the atom (handler wrote through ctx.upsert).
      const next = store.get(txListAtom).find(t => t.id === current.id)
      if (!next) break
      current = next

      // Terminal? The handler just reached a settled state (completed / failed / cancelled /
      // expired). Stop the chain WITHOUT running the expiry check below — otherwise a record
      // that reached a terminal state after maxDurationMs (e.g. a long hidden-tab pause counted
      // against the wall-clock cap) would be clobbered from `completed`/`failed` to `expired`,
      // losing the success or the original TxError. (P0-5)
      if (isTerminalState(current.executionState)) break

      // Handler put us in 'waiting'? Pause the chain; external trigger (e.g. a
      // poller completing, or executeTx being called again) will resume.
      if (current.executionState === 'waiting') break

      // Hard-cap on total lifecycle duration.
      const lifecycle = lifecycleFor(current.kind)
      if (Date.now() - current.createdAt > lifecycle.maxDurationMs) {
        const expired = markExpired(current)
        await ctx.upsert(expired as TxRecord<TxKind>)
        track('tx.expired', { id: current.id, kind: current.kind })
        break
      }
    }
  } catch (err) {
    trackError('tx.executor.run', err, {
      scope: 'tx.executor',
      message: `handler ${handler.kind} threw`,
    })
  } finally {
    running.delete(initial.id)
  }
}

function waitForVisibility(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const store = getDefaultStore()
    const unsub = store.sub(tabVisibleAtom, () => {
      if (store.get(tabVisibleAtom)) {
        unsub()
        resolve()
      }
    })
    signal.addEventListener('abort', () => {
      unsub()
      resolve()
    }, { once: true })
  })
}
