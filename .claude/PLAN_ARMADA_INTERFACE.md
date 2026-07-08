# armada-interface — Architecture & Scaffolding Plan

**Status:** Plan approved. Implementation not started.
**Package:** `@armada/interface`, located at `apps/armada-interface/`.
**Replaces:** `usdc-v2-frontend/` (legacy, adapted ad-hoc from a Namada project — see audit in §14).

## 1. Goal

A new React/Vite app for USDC users of the Armada protocol: shield/unshield, yield deposit/withdraw, payments (shielded → shielded and shielded → external EVM), and cross-chain via CCTP. Built on the same foundations as the crowdfund committer, with a clean transaction-lifecycle model designed for the cross-chain, multi-tx UX requirements.

**This plan covers the scaffold + architectural decisions only.** Feature implementation comes later, screen-by-screen, after the scaffold is in.

## 2. Strategy

- **Copy the committer's spine.** Provider tree, RPC fallback, `react-query` patterns, Jotai conventions, deployment loading, the Vite dev plugin — all proven, all worth inheriting.
- **Build new for the things the committer doesn't need:** multi-tx tracking across chains, cross-chain CCTP lifecycle, Railgun key/sync, relayer submission, encrypted persistence.
- **Salvage the salvageable from `usdc-v2-frontend`:** Railgun unlock pattern, Iris event extraction, yield-rate polling shape. Discard everything else.
- **Use `@armada/ui` for visual primitives.** Single design language across crowdfund apps and this one.

## 3. Workspace placement

```
apps/                                  ← NEW workspace folder
  armada-interface/                    ← @armada/interface
packages/
  ui/                                  (existing @armada/ui)
crowdfund-ui/packages/
  shared/  committer/  observer/  admin/   (existing)
```

Root `package.json` workspaces array gets `"apps/*"` added alongside `"packages/*"` and `"crowdfund-ui/packages/*"`.

## 4. Shared utility duplication — deliberate

`crowdfund-shared` mixes crowdfund-specific code (graph, events, allocation) with generic web utilities (`rpc.ts`, `cache.ts`, `format.ts`, `wagmi-adapter`, `revertMessages.ts`). A future cleanup would extract the generics into a new `@armada/eth-utils` package. **We do NOT do that now** — premature abstraction.

Instead: **duplicate** the small generic utilities into `apps/armada-interface/src/lib/` (~200 LOC). Each duplicated file gets an ABOUTME header noting:

> Duplicated from `@armada/crowdfund-shared`. Extract to `@armada/eth-utils` when both apps need to evolve it.

Tracking note for future extraction lives at the bottom of this doc.

## 5. Folder structure

```
apps/armada-interface/
├── CLAUDE.md                         workspace conventions
├── index.html                        Geist + Charis SIL preconnect
├── package.json                      "@armada/interface"
├── tsconfig.json                     strict, noUncheckedIndexedAccess
├── vite.config.ts                    serveDeployments plugin, plugin-react, dev port 5176
└── src/
    ├── main.tsx                      provider tree (see §6)
    ├── App.tsx                       top-level layout + route outlet
    ├── config/                       CLAUDE.md
    │   ├── network.ts                VITE_NETWORK → hub + client chain configs, RPC lists, relayer URL, indexer URL, Iris URL
    │   ├── wagmi.ts                  wagmi config derived from network.ts
    │   ├── deployments.ts            fetch hub + each client manifest, cache in memory
    │   └── relayer.ts                base URL + endpoint constants, typed error codes
    ├── lib/                          CLAUDE.md  (pure logic, NO React)
    │   ├── rpc.ts                    FallbackJsonRpcProvider (duplicate of crowdfund-shared)
    │   ├── cache.ts                  IndexedDB helpers (tx history, fees, ENS, balances)
    │   ├── format.ts                 truncateAddress, formatUsdc, etc.
    │   ├── revert.ts                 mapRevertToMessage
    │   ├── wagmi-adapter.ts          walletClientToSigner
    │   ├── telemetry.ts              structured console logging with tags (see §16)
    │   ├── relayer.ts                HTTP client: getFees, relay, getStatus + typed errors
    │   ├── cctp.ts                   MessageSent event parsing, Iris poller
    │   ├── railgun/                  SDK wrappers
    │   │   ├── wallet.ts             unlock/lock, mnemonic ↔ Railgun wallet
    │   │   ├── prover.ts             proof generation entry points
    │   │   └── sync.ts               shielded balance sync hooks
    │   └── tx/                       CLAUDE.md (tx lifecycle modeling — see §7)
    │       ├── types.ts              TxRecord, TxKind, TxStage discriminated unions
    │       ├── lifecycles.ts         per-kind stage definitions + terminal/retryable-stage rules
    │       ├── reducer.ts            pure state transitions
    │       ├── storage.ts            IndexedDB persistence + hydration
    │       └── poller.ts             abortable, jittered, backoff-aware
    ├── state/                        CLAUDE.md (Jotai atoms)
    │   ├── tx.ts                     txListAtom + derived (pendingTxsAtom, byIdAtom)
    │   ├── wallet.ts                 shieldedWalletAtom (locked/unlocked, address), balanceAtom
    │   ├── fees.ts                   feeQuoteAtom (cached, staleness-aware)
    │   ├── visibility.ts             tabVisibleAtom (single visibilityState listener)
    │   └── ui.ts                     modal open/close, current page intent
    ├── hooks/                        CLAUDE.md
    │   ├── useWallet.ts              wagmi → ethers signer
    │   ├── useShieldedWallet.ts      Railgun unlock + status
    │   ├── useBalances.ts            unshielded USDC, shielded USDC, yield shares
    │   ├── useYieldRate.ts           polling (30s + event-triggered debounce)
    │   ├── useFees.ts                quote fetch, cache, expiry-aware re-fetch
    │   ├── useTx.ts                  per-tx submit/track; multi-instance safe
    │   ├── useTxHistory.ts           list + filter
    │   └── useCctpAttestation.ts     poll Iris for an in-flight cross-chain tx
    ├── components/                   CLAUDE.md (dumb when possible)
    │   ├── AppLayout.tsx             composes @armada/ui AppHeader + footer + route outlet
    │   ├── balance/                  BalanceCard, BreakdownChip
    │   ├── shield/                   ShieldModal, ShieldForm
    │   ├── unshield/                 UnshieldModal, UnshieldForm
    │   ├── yield/                    YieldDepositModal, YieldWithdrawModal, YieldPositionCard
    │   ├── payments/                 PayShieldedModal, PayExternalModal
    │   ├── tx/                       TxLifecycleStepper, TxHistoryList, TxStatusChip
    │   └── settings/                 PassphraseDialog, MnemonicExport, ResetWallet
    └── pages/                        CLAUDE.md
        ├── Dashboard.tsx             balance card + action triggers (modals)
        ├── History.tsx               tx history
        ├── Settings.tsx              wallet unlock, passphrase, debug
        └── AddressBook.tsx           parked — render-only placeholder for now
```

## 6. Provider tree

```tsx
<StrictMode>
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <RainbowKitProvider theme={darkTheme()}>
        <JotaiProvider>
          <BrowserRouter>
            <MotionConfig reducedMotion="user">
              <Routes>...</Routes>
              <ArmadaToaster />
            </MotionConfig>
          </BrowserRouter>
        </JotaiProvider>
      </RainbowKitProvider>
    </QueryClientProvider>
  </WagmiProvider>
</StrictMode>
```

Nesting order is load-bearing: Query above Jotai (atoms can use queries); RainbowKit above Jotai (ConnectButton needs wagmi context but UI state is below); Toaster sibling of Routes (survives navigation).

## 7. Transaction lifecycle — the central design

This is the most important section. The committer's `useTransactionFlow` is single-tx and sequential — fine for crowdfund, **wrong for this app**. We need multi-tx, multi-chain, lifecycle-aware tracking with persistence and resume-on-reload.

### Model

```ts
type TxKind =
  | 'shield'                      // EVM USDC → shielded USDC (hub)
  | 'shield-xchain'               // EVM USDC on a client chain → shielded USDC (via CCTP to hub)
  | 'unshield-local'              // shielded USDC → EVM USDC (hub)
  | 'unshield-xchain'             // shielded USDC → EVM USDC (client chain, via CCTP)
  | 'transfer-shielded'           // shielded → shielded (outgoing)
  | 'transfer-shielded-received'  // incoming shielded transfer (synthesized from chain history)
  | 'yield-deposit'               // shielded USDC → shielded yield shares
  | 'yield-withdraw'              // shielded yield shares → shielded USDC

// Reviewer rec #1 — execution state is separate from protocol stage to avoid
// semantic overlap (e.g. `stage = iris-attestation-pending` + `status = submitted`
// muddies what "submitted" means).
type TxExecutionState =
  | 'pending'    // record created, executor has not started this stage
  | 'active'     // executor is currently running the stage
  | 'waiting'    // running but blocked on external event (Iris, mint receipt)
  | 'retrying'   // retry attempt in flight after recoverable error
  | 'completed'  // terminal success (stage === lifecycle.terminalSuccess)
  | 'failed'     // terminal failure (unrecoverable)
  | 'expired'    // exceeded lifecycle.maxDurationMs
  | 'cancelled'  // user-initiated abort

type TxWalletContext = {
  evmAddress: string | undefined       // signer wallet at submit, if any
  railgunWalletId: string              // always present — shielded origin
  sourceChainId: number                // hub chain for shielded-only ops
}

type TxRecord<K extends TxKind = TxKind> = {
  id: string                          // ulid (idempotency key)
  kind: K
  executionState: TxExecutionState    // lifecycle position — separate from stage (reviewer #1)
  stage: StageFor<K>                  // protocol position — discriminated per kind
  stagesCompleted: StageFor<K>[]
  updatedSeq: number                  // monotonic OCC counter (reviewer #3); reducer increments, storage rejects stale writes
  createdAt: number
  updatedAt: number
  meta: MetaFor<K>                    // amount, recipient, chain, fee quote — captured at submit
  artifacts: Partial<ArtifactsFor<K>> // tx hashes, attestations, errors — accumulated as stages complete
  walletContext: TxWalletContext      // ownership/session (reviewer #4) — required for history filtering + debugging
}
```

Each `TxKind` declares its **stage sequence + retryable stages + duration cap** in `lib/tx/lifecycles.ts`. Per-kind expiry (reviewer #7) replaces the original global 30 min cap. Retry is MANUAL only — there is deliberately no automatic-retry policy (a buggy auto-resubmit could double-submit a shielded tx and lose funds); `retryableStages` just gates the user-driven "Try Again". Example (cross-chain unshield):

```ts
const unshieldXchain: TxLifecycle = {
  kind: 'unshield-xchain',
  stages: [
    'build-proof', 'submit-relayer', 'hub-burn-confirmed',
    'iris-attestation-pending', 'iris-attestation-ready',
    'client-mint-pending', 'client-mint-confirmed',
  ],
  terminalSuccess: 'client-mint-confirmed',
  retryableStages: ['submit-relayer', 'iris-attestation-pending'],
  estDuration: { p50: 30_000, p90: 120_000 },
  maxDurationMs: 60 * 60_000,                                    // xchain: 60 min cap
}
```

Same-chain kinds use `maxDurationMs: 10 * 60_000`; yield ops `15 * 60_000`. The reviewer's concern (a `shield` stuck for 30 min is dead but Iris legitimately needs 15-20 min) is handled per-kind rather than per-stage; refine to per-stage only when a real case demands it.

Simpler kinds (`transfer-shielded`, `yield-deposit`) have shorter sequences but conform to the same shape — so a single `<TxLifecycleStepper>` renders any kind.

### Storage (optimistic concurrency)

- **In-memory:** `txListAtom: TxRecord[]` (Jotai). Derived atoms: `pendingTxsAtom`, `txByIdAtom(id)`, `txsForKindAtom(kind)`, `txsForStateAtom(state)`. Write path goes through `upsertTxAtom` which rejects stale writes (`existing.updatedSeq >= incoming.updatedSeq`).
- **Persistent:** IndexedDB mirror. Every state transition writes through `putTxIfFresh()` which enforces the same OCC. Hydrate `txListAtom` from IDB on app load via `useTxHistory()`.
- **Resume policy:** on load (and on executor leader-acquire), for each non-terminal record:
  - `Date.now() - createdAt < lifecycle.maxDurationMs` → resume polling for the current stage (`executeTx(record.id)`)
  - else → mark `expired`, show in history with retry button

### Per-tx hook (NOT a singleton)

```ts
const tx = useTx({ kind: 'shield' })
// tx.submit(meta), tx.record, tx.retry(), tx.cancel()
```

Multiple `useTx` instances coexist. Each owns a `id` (ulid). UI subscribes to derived atoms; the hook dispatches into the executor (see §7a) but does not orchestrate.

This fundamentally **fixes the committer's single-tx limitation**.

## 7a. Tx execution engine (reviewer rec #2 + #9)

The executor lives at **module scope** in `lib/tx/executor.ts` — NOT inside a hook. React doesn't own it. Hooks dispatch `executeTx(id)` / `cancelTx(id)`; the engine runs the handler chain in a fire-and-forget Promise.

### Why outside React

If we put the stage pipeline inside `useTx`, we'd hit:
- StrictMode double-mounts (in dev) → duplicate handlers spawned for the same tx
- Component unmount mid-stage → orphaned pollers
- Stale closures over fast-changing state
- Visibility races between mounted hook instances

A module-scope executor sidesteps all of that. Hooks become thin subscription wrappers.

### Architecture

```
TxRecord (persisted) → executeTx(id) → handler.run(record, ctx)
                                       ↓
                                ctx.upsert(nextRecord) — atom + IDB (OCC)
                                       ↓
                              chain loop reloads, decides next step
```

- `registerHandler<K>(handler: StageHandler<K>)` — feature passes register at module-import time.
- `startEngine()` — called once from `App.tsx`'s mount effect. Idempotent. Acquires the leader lock + resumes non-terminal records.
- `executeTx(id)` — spawns the handler chain. Reentrancy-guarded (running set keyed by id). No-op on follower tabs.
- `cancelTx(id)` — aborts the controller, marks record `cancelled`.

### Leader election (reviewer #9)

`startEngine()` requests `navigator.locks.request('armada-tx-executor', { mode: 'exclusive', ifAvailable: true })`. The holder runs handlers; non-holders skip them entirely.

Follower tabs in v1 are passive observers — atoms still hydrate from IDB, but they don't execute. When the leader closes its tab, the lock releases; the next tab to refresh becomes leader. We deliberately did NOT implement cross-tab live sync (BroadcastChannel + follower atom updates) in v1 — open multiple tabs and only the first is interactively useful. Land cross-tab live sync if/when UX feedback demands it.

### Visibility gating

Even on the leader, the chain loop pauses when `tabVisibleAtom` is false. This is polite to API quotas and avoids ratchet-tight retries on backgrounded tabs.

### Stage handler contract

```ts
interface StageHandler<K extends TxKind> {
  kind: K
  run(record: TxRecord<K>, ctx: ExecutorCtx<K>): Promise<void>
  resumableFrom: ReadonlyArray<StageFor<K>>
}
```

The handler runs ONE stage: persists transitions via `ctx.upsert(...)`, honors `ctx.signal` for cancellation, and returns when the stage is done. The chain loop reads the updated record and decides whether to invoke `run` again (next stage), pause (`'waiting'`), or terminate (terminal state).

### UI: one stepper component, all kinds

`<TxLifecycleStepper record={...} />` reads `record.stage` + `lifecycles[record.kind]`, renders a vertical/horizontal stepper. Same component, every kind, uniform UX.

## 8. Fees — fix the race condition explicitly

`useFees()` returns `{ quote, refresh, isStale, error }`.

- Fetch `/fees` on mount, store `quote` (raw USDC units per op type) + `expiresAt`.
- Auto-refresh 30s before `expiresAt`. UI does not need to know.
- If user holds the screen past expiry, `isStale = true` — UI shows "Refreshing fees…" badge and disables submit until next quote lands.
- On `402 FEE_EXPIRED` from `/relay`: one automatic refresh + single retry. Second 402 surfaces to user.

Cache the quote in `feeQuoteAtom` keyed by `chainId`. Persist short-lived quote to IndexedDB so a reload within the TTL avoids a re-fetch.

## 9. Wallet + Railgun — security boundary

- **EVM wallet:** RainbowKit + wagmi (same as committer). No custodial logic.
- **Railgun wallet:**
  - **First run:** generate BIP39 mnemonic, prompt user to choose passphrase + show recovery phrase for confirmation. (Decision: generate-on-first-run only for now; explicit import flow can come later as a setting.)
  - **Encryption at rest:** PBKDF2 (Web Crypto, ≥100k iters) → AES-GCM. Encrypted mnemonic + view/spending keys stored in IndexedDB. Salt + IV stored alongside.
  - **Session unlock:** on every page load, prompt for passphrase. Decrypted key material held in memory; session inactivity timeout = 15 min (configurable).
  - **Never log secrets.** ESLint rule blocks `console.log`/`console.debug` calls in `lib/railgun/` and warns elsewhere when arguments are typed as known secret-bearing types.
  - **Settings:** export mnemonic (with confirm gate), lock now, reset wallet (destroys IDB store).

## 10. Deployments + env

- **`VITE_NETWORK`** env var: `'local'` | `'sepolia'`. Default `'local'`.
- `config/network.ts` resolves to `{ hub: ChainConfig, clients: ChainConfig[], relayerUrl, indexerUrl?, irisUrl }`.
- `config/deployments.ts` loads **multiple manifests** at startup (hub + each client chain), keyed by `chainId`. Schema typed against the actual manifest shapes audited in research:
  - Privacy-pool manifest fields: `privacyPool`, `hookRouter`, `merkleModule`, `verifierModule`, `shieldModule`, `transactModule`, plus `cctp: { tokenMessenger, messageTransmitter, usdc }`.
  - Per-chain manifest fields: `usdc`, `messageTransmitter`, `tokenMessenger`, `domain`.
- Vite plugin `serveDeployments()` (copied from committer's `vite.config.ts`) exposes `/api/deployments/*.json` with the path-traversal guard. No caching headers; relies on Vite dev caching.
- Local dev uses three Anvil chains: hub `:8545`, clientA `:8546`, clientB `:8547`. App connects to all three providers via `FallbackJsonRpcProvider`.

## 11. Polling + caching strategy

| What | Owner | Cadence | Pause-on-hidden | Persistence |
|---|---|---|---|---|
| Unshielded USDC balance | react-query (in `useBalances`) | 15s (local) / 30s (sepolia) | ✓ | rq cache (gcTime 10m) |
| Shielded balances | Railgun SDK events + manual refresh on tx | event-driven | n/a | IDB snapshot on settle |
| Yield rate | react-query + event-triggered debounced refresh | 30s + on Aave events | ✓ | rq cache |
| Fees | `useFees` custom (see §8) | TTL-based, refresh 30s before expiry | ✓ | IDB short-lived |
| Iris attestations | **executor stage handler** (`iris-attestation-pending`) via `lib/tx/poller.ts` | 10s ±20% jitter, exp backoff on 5xx, per-kind cap | ✓ | n/a (lifecycle owns) |
| Receipt-by-hash | **executor stage handler** (`hub-*-confirmed` etc.) | 5s for first 30s, then 15s | ✓ | n/a |
| Indexer health | react-query | 60s | ✓ | n/a |
| ENS | react-query + IDB | on demand + 24h TTL | n/a | IDB |

**Ownership note:** in-flight tx pollers (Iris, receipt confirmations) are owned by the executor's stage handlers — NOT by React hooks. The handlers receive an `AbortSignal` via `ctx.signal` and propagate it into `poll(...)` from `lib/tx/poller.ts`. This means `cancelTx(id)` aborts pollers cleanly, and pollers naturally pause/resume with the chain loop.

Centralization: a single `useTabVisible` hook listens to `visibilitychange` once and publishes to `tabVisibleAtom`. All pollers read this atom; nothing else touches `document.visibilityState`. The executor's chain loop also gates on it.

## 12. Pages + routes (decided)

- `/` — Dashboard. Balance card + action triggers. Send/Shield/Yield are **modal flows**, not pages.
- `/history` — Transaction history.
- `/settings` — Wallet unlock, passphrase, debug toggles.
- `/address-book` — Parked. Renders an "Address book" empty-state placeholder for now; not in the nav until built.

Header nav (in @armada/ui AppHeader's `headerNav` slot): **Dashboard · History · Settings**. The pattern mirrors crowdfund-committer's PageNav rewrite — placeholder for The project is **not** used here.

## 13. What to copy from the committer (verbatim where possible)

- Provider tree composition (§6).
- `FallbackJsonRpcProvider` with sticky rotation (`lib/rpc.ts`).
- `serveDeployments()` Vite plugin with path-traversal guard.
- `VITE_NETWORK` → filename/RPC/indexer resolution pattern.
- `walletClientToSigner()` adapter (wagmi ↔ ethers v6).
- `mapRevertToMessage()` error-string mapping pattern.
- IndexedDB cache helpers (events store dropped, others retained: `meta`, `ens`, plus new `txHistory` and `feeQuotes`).
- Indexer-optional tier (try indexer first, fall back to RPC).
- Receipt log ingestion for optimistic updates (where the wagmi receipt arrives faster than the next poll).
- TS strict + bundler-mode tsconfig, `@/*` path alias.
- Per-folder CLAUDE.md convention.

## 14. What's in usdc-v2-frontend — discard list and salvage list

**Discard (delete entirely):**

- All Namada/Noble/Cosmos paths — ~10 files including `services/polling/namadaPoller.ts`, `services/polling/tendermintRpcClient.ts`, `services/deposit/depositService.ts` Noble forwarding stubs.
- The 2k-line `flowOrchestrator.ts` — replaced by `lib/tx/{reducer,poller,lifecycles}.ts` here, designed from scratch.
- All `as any` casts (15+ instances flagged in audit).
- Plaintext secret storage. Plaintext mnemonic logging. Both replaced by encryption + ESLint enforcement (§9).
- Hardcoded timeouts and polling intervals — replaced by typed config in `network.ts`.
- Pollers without `AbortController` cleanup — replaced by abortable pollers (§11).
- "Undetermined" tx state with no recovery path — replaced by `expired` + retry handler (§7).
- Mixed-concern services with both data fetching and UI orchestration.

**Salvage (port the pattern, not the code):**

- Railgun mnemonic → wallet unlock flow (minus the logging).
- Iris `MessageSent` event extraction (parse nonce, source/dest domains, message bytes).
- Yield-rate polling pattern: periodic + event-triggered debounced.
- Tx storage + hydration *abstraction* (the concept of persistent tx records with reload-survival).
- HTTP client shape for the relayer (typed request/response, error codes).

## 15. Decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| 1 | Workspace at `apps/armada-interface/` | Separates deployable from libraries |
| 2 | Package name `@armada/interface` | Matches `@armada/ui` |
| 3 | Vite dev port 5176 | Avoids 5173/4/5 (observer/committer/admin), 5180 (showcase) |
| 4 | `VITE_NETWORK` controls env (local / sepolia) | Same as committer |
| 5 | All three Anvil chains for local dev (8545/6/7) | Cross-chain flows require all three |
| 6 | Backend = indexer or REST API only | No auth, oracle, or attestation proxy needed at this stage |
| 7 | Generate BIP39 mnemonic on first run | Import flow deferred |
| 8 | Encryption at rest with passphrase-derived AES-GCM key | Replaces plaintext storage in usdc-v2-frontend |
| 9 | Modal flows for Send/Shield/Yield | Pages are Dashboard/History/Settings only |
| 10 | Address Book parked as placeholder | Build later when needed |
| 11 | Telemetry = console-only structured logger | Sentry/PostHog deferred |
| 12 | No strict bundle budget (within reason) | Crypto apps with WASM are inherently large |
| 13 | Copy generic utilities into local `lib/` rather than extract from crowdfund-shared | Avoid premature abstraction |
| 14 | Per-tx hook (`useTx`) supports multiple instances concurrently | Fixes the committer's single-tx limitation |
| 15 | Single visibility listener publishes to atom; pollers gate on it | Avoid N independent `visibilitychange` listeners |
| 16 | TypeScript `strict` + `noUncheckedIndexedAccess` | Stricter than committer |
| 17 | ESLint rule: `ethers` and `@railgun-community/*` import forbidden in `components/**` | Enforces business-logic-out-of-components |
| 18 | ESLint rule: `console.log`/`debug` blocked in `lib/railgun/`, warned elsewhere with secret-typed args | Secret-leak prevention |
| 19 | `eslint-plugin-jsx-a11y` from day one | Accessibility budget |
| 20 | Split execution state from protocol stage (`executionState` separate from `stage`) | Reviewer #1 — avoid semantic overlap (e.g. "submitted" losing meaning when waiting on Iris) |
| 21 | `updatedSeq` optimistic concurrency on `TxRecord` | Reviewer #3 — protect against duplicate-tab writes, poller races, recovery anomalies |
| 22 | `walletContext` on every `TxRecord` (evmAddress, railgunWalletId, sourceChainId) | Reviewer #4 — history filtering + debugging need stable identity |
| 23 | Per-kind `maxDurationMs` + `retry` policy in `TxLifecycle` | Reviewer #7 — global 30-min cap is wrong for shield (too long) and xchain (too short) |
| 24 | Plural shielded wallet schema even though v1 UI is singular | Reviewer #5 — migration later is annoying; cost now is trivial |
| 25 | Tx executor at module scope, NOT inside React | Reviewer #2 — avoids StrictMode double-mount + remount + stale-closure bugs |
| 26 | Single-leader execution via `navigator.locks` (no follower live sync in v1) | Reviewer #9 — prevents duplicate-tab pollers; cross-tab live sync deferred until UX feedback demands it |
| 27 | `EventSource` interface (RPC + Indexer implementations swappable) | Reviewer #8 — hooks don't couple to RPC; indexer rollout is a config change |
| 28 | Typed telemetry `EventRegistry` (compile-time privacy enforcement) | Reviewer #12 — registry edit is the privacy review surface |
| 29 | Fee validator with absolute + ratio bounds (no external price oracle) | Reviewer #6 simplified — guards against decimal bugs / stale cache / config errors without coupling to a price source |
| 30 | Lazy-init Railgun engine with explicit `railgunEngineAtom` warmup state | Reviewer #10 — UI can render "warming up" indicator; preload opportunistically |
| 31 | Memory zeroization discipline in `lib/railgun/` (best-effort `fill(0)` on key buffers) | Reviewer #11 — JS makes this imperfect but discipline reduces leak surface |
| 32 | WebAuthn-friendly encryption schema (KEK/DEK separation; password-only for v1) | Reviewer #11 — don't paint into a corner that assumes password-only forever |

## 16. Telemetry

`lib/telemetry.ts` exposes:

```ts
track(event: string, props: Record<string, unknown>): void
trackTxTransition(record: TxRecord, fromStage, toStage): void
trackError(scope: string, err: unknown, props?: Record<string, unknown>): void
```

Initial implementation logs structured JSON to `console.info`/`console.error` with stable tag prefixes. Every tx transition emits. Every caught error emits. Later this can be wired to Sentry/PostHog by swapping the implementation file — call sites don't change.

## 17. Test plan baseline (scaffold-only)

- All packages typecheck under `tsc --noEmit` (workspace `@armada/interface` and existing workspaces both).
- `npm run dev --workspace=@armada/interface` boots Vite on `:5176`.
- AppHeader renders with placeholder nav (Dashboard · History · Settings) using `@armada/ui` primitives.
- Empty Dashboard, History, Settings pages render at their routes.
- All hooks/services are stubbed with `TODO: implement` + a `telemetry.track('stub', { ... })` call so we can see the shape without real integrations.
- Zero console errors on cold load.

No real wallet, contract, relayer, Railgun, or CCTP integration in the scaffold. Those land feature-by-feature in subsequent passes.

## 18. Out of scope / deferred

- Real wallet/contract/relayer/Railgun/CCTP integrations.
- Indexer-side work (we'll integrate against the existing indexer pattern if one exists for the privacy pool; else add a flag for it).
- e2e testing setup.
- Real telemetry sink (Sentry/PostHog).
- Service worker / offline support.
- i18n.
- Hardware wallet edge cases beyond what wagmi covers out of the box.
- Mnemonic import flow (only generate-on-first-run for now).

## 19. Extraction tracking

When this app and the crowdfund apps both want to evolve `rpc.ts` / `cache.ts` / `format.ts` / `wagmi-adapter.ts` / `revert.ts`, extract them to a new `@armada/eth-utils` package. Both consumers depend on it; the duplicates here are removed.

Don't do this preemptively. Do it when the duplication actively causes friction.

## 20. Scaffolding execution order (when work begins)

1. Workspace skeleton — `apps/armada-interface/`, `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, ESLint config.
2. Add workspace path to root `package.json` workspaces; npm install with `--legacy-peer-deps`.
3. `main.tsx` provider tree; empty `App.tsx` + routes.
4. `config/{network,wagmi,deployments,relayer}.ts` with typed configs but stub return values.
5. `lib/` skeleton — copy `rpc.ts`/`cache.ts`/`format.ts`/`wagmi-adapter.ts`/`revert.ts` from crowdfund-shared (with ABOUTME headers noting the duplication).
6. `lib/telemetry.ts`.
7. `lib/tx/` skeleton — `types.ts` defining all `TxKind` lifecycles, `reducer.ts`, `storage.ts`, `poller.ts` stubs.
8. `state/` atoms — empty defaults.
9. `hooks/` — stubbed with TODO + telemetry calls.
10. `components/AppLayout.tsx` using `@armada/ui` `AppHeader` (or build a new `armada-interface`-local AppHeader if we don't want the crowdfund-shared one — TBD when wiring).
11. Pages (Dashboard, History, Settings) — empty placeholders.
12. CLAUDE.md in every folder (root + `config/` + `lib/` + `lib/tx/` + `state/` + `hooks/` + `components/` + `pages/`).
13. Verify typecheck + boot + zero console errors.
14. Commit as a feature branch; PR.

After scaffold lands, feature passes proceed per the audit's tx-flow inventory (shield → unshield → yield → payments → cross-chain), each as its own PR.

## 21. Open questions for future passes

These don't block scaffolding but should be answered before the relevant feature lands:

- Indexer schema — do we have an indexer for privacy-pool events (similar to the crowdfund indexer), or do we read from RPC only? Affects `useBalances`, `useTxHistory`.
- Iris CORS — does Circle's Iris API allow browser-origin requests in production, or do we need a relayer-side proxy?
- Multi-wallet support — if the user has multiple EVM wallets, is the Railgun wallet tied to a specific one? Or is the Railgun mnemonic independent?
- Hardware wallet UX — Ledger/Trezor signing flows need real testing before we claim "supported".
- Tx history pagination — at what point does history need server-side paging?
