# lib/tx/

Transaction lifecycle model. The most important architectural surface in this app — read `.claude/PLAN_ARMADA_INTERFACE.md` §7 + §7a before touching.

## Files

| File | Purpose |
|---|---|
| `types.ts` | `TxKind` discriminated union; per-kind stage unions; `TxRecord<K>` with `executionState` + `stage` + `updatedSeq` + `walletContext`; `TxLifecycle<K>` with `maxDurationMs` + `retryableStages` (no auto-retry policy). |
| `lifecycles.ts` | One `TxLifecycle` per `TxKind` — stage sequence, terminal-success stage, retryable stages (for the user-driven "Try Again"), per-kind expiry cap. |
| `reducer.ts` | Pure transitions: `advance`, `markWaiting`, `markRetrying`, `markFailed`, `markExpired`, `markCancelled`, `shouldResume`. Every transition increments `updatedSeq`. |
| `storage.ts` | IDB persistence: `putTxIfFresh` (OCC enforced via `updatedSeq`), `putTx` (unconditional, hydration only), `loadAllTx`, `deleteTx`. |
| `executor.ts` | **Module-scope** execution engine. Runs stage handlers outside React, owns AbortControllers, leader-elected via `navigator.locks`. |
| `poller.ts` | Generic abortable / jittered / backoff-aware poll loop. Stage-specific adapters (Iris, RPC, relayer) plug in here. |

## Invariants

- **`TxRecord` is the only persistent representation of a transaction.** No parallel storage. No optimistic balance mutation. Balance changes come from the next balance refresh, NOT from in-flight tx state.
- **Stages are append-only.** A record never moves "backwards" through stages — failures and retries re-enter the same stage; non-retryable failures terminate and a new record (new ulid) is required to retry from scratch.
- **`reducer.ts` is pure.** No IDB writes, no React. Hooks / executor call the reducer, then write the result via `state/tx.ts::upsertTxAtom` + `storage::putTxIfFresh`.
- **`updatedSeq` enforces optimistic concurrency.** Every transition increments it; `putTxIfFresh` and `upsertTxAtom` reject stale writes. This guards against duplicate-tab writes, poller races, and crash recovery anomalies.
- **`id` is a ulid generated client-side at submit.** Idempotency key: re-submitting with the same id is a no-op upsert (executor's reentrancy guard).
- **`walletContext` is captured at submit and immutable.** History filtering + debugging rely on stable identity even if the user later switches EVM or Railgun wallets.

## Adding a new `TxKind`

1. Extend the `TxKind` union in `types.ts`.
2. Add a `Stage<NewKind>` union + extend `StageFor<K>`.
3. Add a `Meta<NewKind>` interface + extend `MetaFor<K>`.
4. (If cross-chain) extend `ArtifactsFor<K>` or reuse `ArtifactsXchain`.
5. Add a `TxLifecycle<NewKind>` entry in `lifecycles.ts` with `maxDurationMs` + `retryableStages`.
6. Register a `StageHandler<NewKind>` somewhere that gets imported on app load (typically a `features/<area>/handler.ts` module that side-effects `registerHandler(...)`).
7. Optionally: custom rendering in `components/tx/<NewKind>/`. The default stepper handles it if you skip.

That's it. The reducer, storage, executor, and pollers handle any kind that conforms to the type contract.

## Executor

The executor lives at **module scope** in `executor.ts`. React doesn't own it. Hooks dispatch `executeTx(id)` / `cancelTx(id)`; the engine runs the handler chain in a fire-and-forget Promise.

Key behaviour:

- **Single-leader via `navigator.locks`.** On `startEngine()` the engine requests an exclusive lock named `armada-tx-executor` with `ifAvailable: true`. The holder runs handlers; other tabs are passive observers (atoms still hydrate from IDB, but `executeTx` is a no-op). When the leader tab closes, the lock releases and a follower tab can take over on next start.
- **Visibility-gated.** Even on the leader, when the tab is hidden (`tabVisibleAtom = false`) the handler chain pauses. Resumes on visibility change.
- **Resume on unlock (leader only).** `resumeForWallet(walletId)` runs from `useTxResume` once the active wallet unlocks — NOT from `startEngine` (the leader lock is acquired pre-unlock, when there's no decryption key and `loadAllTx` returns `[]`). It reads non-terminal records from IDB and, per record: past the per-kind budget → `expired`; has a `sourceTxHash` (already broadcast) → `executeTx` re-attaches the watcher (safe because submit stages are idempotent — WS1.3); otherwise (no hash, never reached the wire) → `failed` with `INTERRUPTED` ("nothing was sent"). Idempotent per (walletId, session). Resume never re-broadcasts and never re-prompts the wallet on load.
- **AbortController per running tx.** `cancelTx(id)` aborts the controller; the handler must check `ctx.signal` and propagate. Stage handlers wire `ctx.signal` into their pollers.

### Stage naming caveat — `'submit-relayer'` is a framework label

The `'submit-relayer'` stage exists in every kind's lifecycle (`shield`, `unshield-local`, `transfer-shielded`, `yield-deposit`, `yield-withdraw`, `unshield-xchain`, `shield-xchain`). The name suggests the relayer submits the tx — that's the eventual model when `submitRelay` is wired (see `lib/relayer.ts`), but **today every handler submits via the user's own wallet** through `wagmi/actions::sendTransaction` / `writeContract`. The stage name is a stable framework label for "tx-on-the-wire," not an indicator of who sends it.

This matters when scoping work like fee display, ETA estimation, or stage copy — don't assume `'submit-relayer'` means we're in relayer-mediated mode. Per-kind handler is the source of truth for submission shape.

### Stage handler contract

```ts
interface StageHandler<K extends TxKind> {
  kind: K
  run(record: TxRecord<K>, ctx: ExecutorCtx<K>): Promise<void>
  resumableFrom: ReadonlyArray<StageFor<K>>
}
```

- `run` executes the **current** stage. It writes transitions via `ctx.upsert(nextRecord)`.
- `run` returns when the stage is done (next stage advanced) OR the record is in `'waiting'` (chain pauses).
- `run` MUST honour `ctx.signal`. Throwing on abort is fine.
- `resumableFrom` lists stages this handler can safely re-enter on app reload — typically the same as `lifecycle.retryableStages`.

### Outer try/catch contract

Every handler's `async run` wraps its switch/dispatch in `try { ... } catch (err) { ... }`. The catch MUST follow this shape so cancel + dismiss work correctly:

```ts
} catch (err) {
  // 1. If the signal aborted, abortAndMark (cancel/dismiss) already wrote the terminal state.
  //    Returning here without upserting prevents us from clobbering the cancelled/dismissed
  //    record with a failed one. OCC would silently drop the write anyway — explicit return
  //    is clearer about intent and avoids a misleading telemetry event.
  if (ctx.signal.aborted) return
  // 2. Otherwise classify the thrown value into a typed TxError and write it via markFailed.
  //    classifyHandlerError preserves branded TxErrors (POLL_TIMEOUT / TX_REVERTED from inner
  //    helpers like waitForReceiptOrFail) so the category isn't lost in the outer catch.
  const failed = markFailed(record, classifyHandlerError(err, '<kind> failed.', record.artifacts.sourceTxHash))
  await ctx.upsert(failed)
}
```

The abort-check-before-markFailed pattern is invariant across every handler. If you add a new handler, copy the shape rather than improvising.

## Polling adapters

`poller.ts` exports a generic `poll(pollOnce, opts)`. Stage-specific adapters (one per polling type) call into `lib/cctp.ts`, `lib/relayer.ts`, or RPC directly via `lib/events`. Convention: the adapter function is named `poll<Source>Once(...)` (e.g. `pollIrisOnce`, `pollReceiptOnce`) and returns `Promise<T | null>` — null means "no result yet, keep polling".

## Resume policy

Resume runs from `useTxResume` (hooks/) when the active wallet unlocks — leader-gated and
idempotent per (walletId, session) via a module-scope `Set`. It calls `resumeForWallet(walletId)`,
which reads non-terminal records straight from IDB (`loadAllTx(walletId)`) rather than `txListAtom`
(hydration races leader-lock acquisition; `upsertTxAtom` is OCC-safe so seeding here can't regress
newer state). Per non-terminal record:

- past `lifecycle.maxDurationMs` (wall-clock from `createdAt`) → `markExpired`.
- has `artifacts.sourceTxHash` (the tx is already on chain) → `executeTx(record.id)` to re-attach
  the watcher (receipt / relayer status / cross-chain delivery polling). Safe because every submit
  stage is idempotent (WS1.3) — a re-entry with a known hash never re-broadcasts.
- otherwise (no hash — interrupted at `build-proof`, or at `submit-relayer` before the tx hit the
  wire) → `markFailed` with `INTERRUPTED`. Resuming would re-prompt the wallet / re-POST out of
  nowhere, so we fail honestly: "nothing was sent — start a new transaction."

Resume thus only ever RE-WATCHES an already-broadcast tx; it never submits and never re-prompts on
load. `maxDurationMs` is per-kind: 10 min same-chain (`shield`, `unshield-local`,
`transfer-shielded`), 15 min yield, 60 min xchain. (`StageHandler.resumableFrom` is currently
unread — the has-hash test supersedes it; see WS7 docs cleanup.)

## Terminal-write guard

`upsertTxAtom` (state/tx.ts) and `putTxIfFresh` (storage.ts) refuse any write that would move a
record from a terminal state (`completed | failed | expired | cancelled`) to a non-terminal one,
*regardless of `updatedSeq`* — this stops a late poller / proof-progress write (which can carry a
higher seq from a stale in-flight reference) from resurrecting a cancelled/failed/expired record.
Two carve-outs: terminal→terminal is allowed (the history-recovery `expired|failed → completed`
upgrade path, WS1.7), and terminal→`retrying` is allowed (an intentional `retryTx`/`markRetrying`;
stale writes only ever produce `active`/`waiting`, never `retrying`).

## Telemetry conventions

The tx executor emits structured events via `lib/telemetry.ts`. The EventRegistry's `tx.*` keys are the only allowlist; adding a new event = editing the registry.

Never emit amounts, recipients, or anything tied to shielded identities. Use ids and kinds.
