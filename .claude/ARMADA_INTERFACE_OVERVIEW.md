# `armada-interface` — Functionality, Architecture, and Open Questions

**Purpose of this document:** Self-contained summary for review by an external agent. Pulls together the protocol context, current scaffold state, architectural decisions, planned functionality, and unresolved questions. Reviewing agent should not need to read the wider codebase to give useful feedback on architecture and direction.

**Status:** Scaffold landed in PR #272 (merged or in-review at time of writing). No real wallet/contract/relayer/Railgun integration yet — every flow stubs through structured telemetry so shapes are real and side effects are deferred.

> **⚠️ STALE (kept as a point-in-time review digest).** As of 2026-08 this document describes the original PR-#272 *scaffold* state, which is long superseded: all flows (shield/unshield/transfer/yield + cross-chain), the V2 signature-derived shielded wallet, `@armada/sdk` migration, chain history recovery, the full visual redesign, and pay-via-link are all wired end-to-end. For current architecture read **`.claude/PLAN_ARMADA_INTERFACE.md`** + `apps/armada-interface/CLAUDE.md`; treat the sections below as historical context only.

**For detailed plan:** see `.claude/PLAN_ARMADA_INTERFACE.md` (this is a digest of that, with added protocol context).

---

## 1. What is `armada-interface`?

A React/Vite single-page app for end users of the **Armada** protocol. Concretely, a wallet UI that lets a user:

- **Shield USDC** into a privacy pool (EVM USDC → shielded USDC).
- **Unshield USDC** back to an EVM address — either same chain (hub) or to another chain via **Circle's CCTP (Cross-Chain Transfer Protocol)**.
- **Deposit shielded USDC into a yield vault** (Aave-backed) and see yield earnings accrue.
- **Withdraw** yield shares back to shielded USDC.
- **Make payments**:
  - Shielded → shielded (private transfer to another 0zk address).
  - Shielded → external EVM address (unshield + send, same chain or cross-chain).

This app **replaces** an existing legacy app, `usdc-v2-frontend/`, which was adapted ad-hoc from a Namada project and has known structural problems (2k-line orchestrator with race conditions, plaintext mnemonic storage, ~15 `as any` casts, dead Namada/Noble/Cosmos paths, broken retry logic for failed txs). The rewrite preserves a few patterns (Railgun unlock flow, Iris event extraction, yield-rate polling shape) and discards the rest.

---

## 2. Protocol context (just enough to follow architecture)

### Privacy pool (Railgun-derived)

A hub-and-spoke shielded pool for USDC:

- **Hub chain** (Ethereum mainnet target; Sepolia for testnet; Anvil `:8545` locally): hosts the `PrivacyPool` contract and the **shielded merkle tree**. All commitments live here. The Railgun SDK (`@railgun-community/wallet`, `@railgun-community/engine`) handles tree sync, key derivation, and Groth16 ZK proof generation client-side.
- **Client chains** (Base + Arbitrum Sepolia for testnet; Anvil `:8546`/`:8547` locally): host lightweight `PrivacyPoolClient` contracts. They participate only in cross-chain flows.
- Users hold **Railgun wallets**: BIP39 mnemonic → spending key + viewing key → 0zk addresses. The mnemonic + keys are encrypted client-side; never custodial.

### CCTP integration

Cross-chain flows ride on **Circle's CCTP V2**:

- Source chain `TokenMessenger.depositForBurn(...)` burns USDC, emits `MessageSent` event with a `messageHash`.
- An **attestation service** (Circle's "Iris" API for testnet/mainnet; a mock module locally) signs the message after the burn finalizes.
- Destination chain `MessageTransmitter.receiveMessage(message, attestation)` (or a hook router that wraps it atomically) mints the equivalent USDC.
- Local mode skips Iris and relays atomically via `MockMessageTransmitter`.

### Relayer

A Node service at `relayer/armada-relayer.ts` (port 3001 locally):

- `GET /fees` → fee schedule with TTL (5 min, cache-id-keyed)
- `POST /relay` → submit a populated tx (chainId + to + data + feesCacheId)
- `GET /status/:txHash` → poll for confirmation
- Two CCTP modes: `mock` (local, instant relay), `real` (Sepolia, polls Iris)
- Stateless beyond a short dedup window + fee cache

The relayer accepts populated calldata, signs and submits as itself, eats gas. Users pay via USDC fees baked into the operation (which is why the fee quote lives upstream of submission). The relayer is open by default (no auth) — production deployment would protect with rate limits or origin checks at the proxy layer.

### Deployment manifests

Live in `deployments/` at the repo root. The shape that matters for this app:

- **Hub manifest** (`privacy-pool-hub*.json`): `privacyPool`, `merkleModule`, `verifierModule`, `shieldModule`, `transactModule`, `hookRouter`, plus CCTP addresses (`tokenMessenger`, `messageTransmitter`, `usdc`).
- **Client manifest** (`privacy-pool-client*.json`): `privacyPoolClient`, `hookRouter`, CCTP addresses, plus a `hub: { domain, privacyPool }` back-reference.

Per app: load hub + each client manifest in parallel at boot.

### Sibling apps in this repo

- **`@armada/ui`** (`packages/ui/`) — design-system primitives ported from a Figma-derived mockup at `/Volumes/T7/armada-crowdfund/`. CSS Modules + design tokens. Used by armada-interface for visual primitives (`ArmadaLogo`, `NavBar`, `WalletButton`, `Button`, `Tag`).
- **`@armada/crowdfund-*`** (`crowdfund-ui/packages/`) — a separate product (token launch crowdfund) with its own observer/committer/admin apps. Established the patterns we copy: provider tree, RPC fallback, Vite dev plugin for manifests, indexer-optional tier, `walletClientToSigner` adapter. **Same tooling, different product.**
- **`packages/ui/showcase/`** — visual demo app for `@armada/ui` primitives.

---

## 3. Current scaffold state

**Workspace:** `apps/armada-interface/`, package name `@armada/interface`, dev port `5176`. Boots via `npm run armada:interface` from the repo root.

### File map

```
apps/armada-interface/
├── CLAUDE.md                         workspace conventions
├── package.json                      "@armada/interface"
├── tsconfig.app.json                 strict + noUncheckedIndexedAccess (stricter than committer)
├── vite.config.ts                    serveDeployments plugin (path-traversal guarded) + react + tailwind
├── index.html                        Geist + Charis SIL preconnect
└── src/
    ├── main.tsx                      provider tree (see §4.1)
    ├── App.tsx                       installs visibility listener, hydrates tx history, renders AppLayout + <Outlet />
    ├── index.css                     @import tailwindcss + @armada/ui tokens.css + global.css
    ├── config/                       network, wagmi, deployments, relayer  (env-driven)
    ├── lib/                          pure logic (no React)
    │   ├── rpc.ts                    FallbackJsonRpcProvider with sticky rotation
    │   ├── cache.ts                  IndexedDB helpers (typed by store name)
    │   ├── format.ts                 truncateAddress, formatUsdc, parseUsdcInput
    │   ├── revert.ts                 mapRevertToMessage — pattern-match contract reverts to user-readable text
    │   ├── wagmi-adapter.ts          walletClientToSigner — viem WalletClient → ethers v6 JsonRpcSigner
    │   ├── telemetry.ts              structured console logger (track / trackTxTransition / trackError)
    │   ├── relayer.ts                STUB — typed HTTP client signatures, throws on call
    │   ├── cctp.ts                   STUB — MessageSent parsing + Iris poller signatures
    │   ├── railgun/{wallet,prover,sync}.ts   STUB — SDK wrappers
    │   └── tx/                       transaction lifecycle model — see §4.2
    │       ├── types.ts              TxKind discriminated union + per-kind Stage/Meta/Artifacts unions
    │       ├── lifecycles.ts         one TxLifecycle entry per TxKind
    │       ├── reducer.ts            pure transitions (advance / markFailed / markExpired)
    │       ├── storage.ts            IDB persistence + hydration
    │       └── poller.ts             abortable, jittered, exponential-backoff polling loop
    ├── state/                        Jotai atoms
    │   ├── tx.ts                     txListAtom (root) + derived selectors (pendingTxsAtom, txByIdAtom, etc.)
    │   ├── wallet.ts                 evmAddressAtom, shieldedWalletAtom, usdcBalancesAtom, shieldedUsdcAtom, yieldSharesAtom
    │   ├── fees.ts                   feeQuoteAtom + feeQuoteIsStaleAtom (derived)
    │   ├── visibility.ts             tabVisibleAtom — single source of truth for document.visibilityState
    │   └── ui.ts                     openModalAtom
    ├── hooks/                        one concern per hook
    │   ├── useTabVisible.ts          WORKING — single visibilitychange listener
    │   ├── useWallet.ts              WORKING — wagmi → ethers signer adapter
    │   ├── useTxHistory.ts           WORKING — IDB hydration on mount
    │   ├── useTx.ts                  SKELETON — submit/retry/cancel wired; stage pipeline TODO
    │   ├── useShieldedWallet.ts      STUB
    │   ├── useBalances.ts            STUB
    │   ├── useYieldRate.ts           STUB
    │   ├── useFees.ts                STUB
    │   └── useCctpAttestation.ts     STUB
    ├── components/
    │   ├── AppLayout.tsx             fixed 24-px-inset header (ArmadaLogo + NavBar + WalletConnector), main fills + centers content
    │   ├── WalletConnector.tsx       RainbowKit ConnectButton.Custom render prop → @armada/ui WalletButton for all four states (loading/disconnected/wrong-network/connected)
    │   └── {balance,shield,unshield,yield,payments,tx,settings}/   EMPTY folders, ready for features
    └── pages/                        thin route shells
        ├── Dashboard.tsx              placeholder
        ├── History.tsx                placeholder (reads txListAtom via useTxHistory)
        ├── Settings.tsx               placeholder
        └── AddressBook.tsx            parked placeholder (not in nav)
```

### What works today

- App boots clean in <1 second (`npm run armada:interface` → `http://localhost:5176`).
- All four routes (Dashboard, History, Settings, AddressBook) render.
- Wallet connect works end-to-end via RainbowKit; truncated address (mockup-style 0x1234…abcd) renders in the header pill after connect.
- TypeScript strict pass with `noUncheckedIndexedAccess`.
- Visibility listener gates polling readiness (atom is set, no consumers yet).
- IDB tx-history hydration runs (no records yet, but the path is live).

### What's stubbed (intentional)

- `lib/relayer.ts`, `lib/cctp.ts`, `lib/railgun/*` — function signatures only, throw on call.
- `useShieldedWallet`, `useBalances`, `useYieldRate`, `useFees`, `useCctpAttestation` — return defaults/null/TODO.
- `useTx.submit()` creates a `TxRecord` and writes it to IDB, but does NOT yet kick off the stage pipeline (the bridge from `submit()` → `build-proof` → `submit-relayer` → … is the next feature pass).

---

## 4. Architecture decisions

### 4.1 Provider tree

```tsx
<StrictMode>
  <WagmiProvider config={wagmiConfig}>          // wallet state, chain switching
    <QueryClientProvider client={queryClient}>  // react-query for HTTP/RPC caching
      <RainbowKitProvider theme={darkTheme()}>  // connect-button modal UX
        <JotaiProvider>                          // app state atoms
          <BrowserRouter>
            <MotionConfig reducedMotion="user">  // framer-motion defaults
              <Routes>...</Routes>
              <Toaster />                        // sonner — sibling of Routes so it survives nav
            </MotionConfig>
          </BrowserRouter>
        </JotaiProvider>
      </RainbowKitProvider>
    </QueryClientProvider>
  </WagmiProvider>
</StrictMode>
```

Order is load-bearing: Query above Jotai (atoms may use queries inside selectors); RainbowKit above Jotai (ConnectButton needs wagmi context); Toaster as a sibling of Routes (survives navigation).

### 4.2 Transaction lifecycle model — the central architectural piece

The hardest UX problem in this app: **multiple in-flight transactions, across chains, with persistence and resume-on-reload**. The crowdfund-committer's `useTransactionFlow` is single-tx and sequential — that doesn't fit. We model it explicitly.

**Seven `TxKind`s** with their own stage sequences:

| `TxKind` | Stages |
|---|---|
| `shield` | `build-proof` → `submit-relayer` → `hub-confirmed` |
| `unshield-local` | `build-proof` → `submit-relayer` → `hub-confirmed` |
| `unshield-xchain` | `build-proof` → `submit-relayer` → `hub-burn-confirmed` → `iris-attestation-pending` → `iris-attestation-ready` → `client-mint-pending` → `client-mint-confirmed` |
| `transfer-shielded` | `build-proof` → `submit-relayer` → `hub-confirmed` |
| `yield-deposit` | `build-proof` → `submit-relayer` → `hub-confirmed` |
| `yield-withdraw` | `build-proof` → `submit-relayer` → `hub-confirmed` |
| `payment-xchain` | same as `unshield-xchain` (the 7-stage cross-chain flow) |

**Each tx is a `TxRecord<K>`** with execution state separate from protocol stage (reviewer rec #1), OCC versioning (rec #3), and captured wallet context (rec #4):

```ts
type TxRecord<K extends TxKind = TxKind> = {
  id: string                          // ulid (idempotency key)
  kind: K
  executionState: 'pending' | 'active' | 'waiting' | 'retrying' | 'completed' | 'failed' | 'expired' | 'cancelled'
  stage: StageFor<K>                  // protocol position — discriminated per kind
  stagesCompleted: StageFor<K>[]
  updatedSeq: number                  // monotonic OCC counter; stale writes are rejected
  createdAt: number
  updatedAt: number
  meta: MetaFor<K>                    // user inputs (amount, recipient, etc.)
  artifacts: Partial<ArtifactsFor<K>> // tx hashes, attestations, errors — accumulated
  walletContext: { evmAddress?: string; railgunWalletId: string; sourceChainId: number }
}
```

Per-kind expiry caps live on the lifecycle (rec #7): same-chain ops 10 min, yield ops 15 min, xchain ops 60 min.

**Tx execution engine** (reviewer rec #2 + #9) — lives at **module scope** in `lib/tx/executor.ts`, NOT inside React. Hooks dispatch `executeTx(id)` / `cancelTx(id)`; the engine runs stage handlers in a fire-and-forget Promise. This avoids StrictMode double-mount, stale-closure, and remount races. Leader election via `navigator.locks` — only one tab actually runs handlers; others are passive observers (no follower live sync in v1).

**Storage:** `txListAtom: TxRecord[]` (Jotai) mirrored to IndexedDB on every transition via `putTxIfFresh()` which rejects stale writes. On app reload, hydrate from IDB; for each non-terminal record, either resume polling (per-kind cap not exceeded) or mark `expired`.

**Per-tx hook is multi-instance:** `useTx({ kind })` generates a fresh ulid on `submit()`. Multiple concurrent `useTx` instances coexist. UI subscribes to `txByIdAtom(id)`. This fixes the committer's single-tx limitation.

**Pollers** are owned by the executor's stage handlers, not by React. `lib/tx/poller.ts` exposes a generic `poll(pollOnce, opts)` with AbortController, jitter (±20%), exponential backoff on errors, per-kind total timeout. Stage-specific adapters plug in (e.g. `pollIrisOnce` for attestations). Pollers gate on `tabVisibleAtom`.

**UI:** a single planned `<TxLifecycleStepper record={...} />` component reads `record.stage` + the kind's lifecycle definition, renders a stepper. Same component handles all seven kinds.

### 4.3 State management

**Jotai atoms** for shared state. Plural-wallet schema (rec #5) means the wallet atoms are keyed by `railgunWalletId` even though v1 UI is singular:

- `txListAtom` (root, persisted to IDB) + derived selectors (`pendingTxsAtom`, `txByIdAtom(id)`, `txsForKindAtom(K)`, `txsForStateAtom(s)`).
- `evmAddressAtom` (mirrored from wagmi).
- `shieldedWalletsAtom: Record<string, ShieldedWalletState>` (plural), `activeRailgunWalletIdAtom`, derived `activeShieldedWalletAtom`.
- `railgunEngineAtom` — `'cold' | 'warming' | 'ready' | 'failed'`. UI renders "warming up…" indicator.
- `feeQuoteAtom` + derived `feeQuoteIsStaleAtom` (auto-true 5 s before TTL).
- `tabVisibleAtom` — single source of truth, written only by `useTabVisible()`.
- `openModalAtom` — controls which action flow (shield/unshield/yield/payment) is currently open.

**No Redux, no Zustand, no context-only.** Same pattern as the crowdfund apps. Non-React modules (the executor, `prover.ts`) access atoms via Jotai's `getDefaultStore()`.

### 4.4 Polling + caching matrix

| What | Owner | Cadence | Pauses on hidden tab? | Persistence |
|---|---|---|---|---|
| Unshielded USDC balance | react-query (`useBalances`) | 15 s local / 30 s sepolia | yes | rq cache |
| Shielded balance | Railgun SDK events + manual refresh on tx | event-driven | n/a | IDB snapshot on settle |
| Yield rate | react-query + event-triggered debounced refresh | 30 s + on-event | yes | rq cache |
| Fee quotes | `useFees` custom, TTL-based | refresh 30 s before expiry | yes | IDB short-lived |
| Iris attestations | **executor stage handler** (`iris-attestation-pending`) | 10 s ±20% jitter, exp backoff on 5xx, per-kind cap | yes | n/a — lifecycle owns it |
| Receipt by hash | **executor stage handler** (`hub-*-confirmed`) | 5 s for first 30 s then 15 s | yes | n/a |
| Indexer health (optional tier) | react-query | 60 s | yes | n/a |
| ENS | react-query + IDB | on demand, 24 h TTL | n/a | IDB |

In-flight tx pollers are owned by the **executor's stage handlers** (not by React hooks). They receive `ctx.signal` and propagate it into `poll(...)` so `cancelTx(id)` aborts cleanly.

### 4.5 Wallet + security boundary

- **EVM wallet:** RainbowKit + wagmi (Anvil hub + 2 client chains for local; Sepolia + Base/Arb Sepolia for testnet). The `walletClientToSigner` adapter bridges viem → ethers v6 so existing ethers-based contract code works unchanged.
- **Railgun wallet:**
  - **Plural schema** (rec #5): atoms keyed by `railgunWalletId`. UI singular in v1; schema future-proof.
  - **First run:** generate BIP39 mnemonic. User chooses a passphrase. Mnemonic + view/spending keys encrypted with PBKDF2 (Web Crypto, ≥100k iters) + AES-GCM. Encrypted blob in IDB. Salt + IV stored alongside. KEK/DEK separation so a future WebAuthn flow can wrap the DEK without schema change (rec #11).
  - **Subsequent loads:** prompt for passphrase → decrypt → hold key material in memory for the session. Inactivity timeout 15 min (configurable).
  - **Never log secrets.** Planned ESLint guard: `no-console` rule with `error` severity in `lib/railgun/`. Telemetry is typed via `EventRegistry` (rec #12) — registry edits are the privacy review surface.
  - **Memory zeroization** discipline (rec #11): key buffers `fill(0)` after use; avoid mnemonic-as-string where possible.
  - Settings page: export mnemonic (with confirm gate), lock now, reset wallet (irreversible).
- **Engine warmup** (rec #10): `railgunEngineAtom` exposes `cold → warming → ready → failed`. UI shows "warming up…" indicator. Initialisation is lazy; app preloads opportunistically on first nav to a tx surface.

### 4.6 Deployment & env

- `VITE_NETWORK` env var: `'local'` (default) | `'sepolia'`.
- `config/network.ts` resolves to `{ hub, clients[], relayerUrl, irisUrl, indexerUrl?, pollIntervalMs }`.
- `config/deployments.ts` fetches **multiple manifests in parallel** at boot (hub + each client) via the `serveDeployments()` Vite dev plugin (path-traversal guarded). Cached in memory.
- For local: hub on `:8545`, clientA on `:8546`, clientB on `:8547` (Anvil).
- For sepolia: Ethereum Sepolia (hub) + Base Sepolia + Arbitrum Sepolia (clients).
- Multi-RPC ordered fallback via `FallbackJsonRpcProvider` (sticky rotation on success).

### 4.7 Telemetry

`lib/telemetry.ts` exposes:

```ts
track<E extends EventName>(event: E, props: EventRegistry[E]): void
trackTxTransition(record, fromStage, toStage): void
trackError(scope: string, err: unknown, props?: ErrorProps): void
```

`EventRegistry` (rec #12) is a typed map of event-name → exact props shape. Adding a new event requires editing the registry — the PR diff IS the privacy review. Compile-time wall against accidentally logging `amount`, `recipient`, `address`, `mnemonic`, etc.

Implementation logs structured JSON to console with stable tags. Swappable to Sentry/PostHog later by editing the implementation file; call sites don't change.

### 4.8 Styling

- `@armada/ui` for visual primitives (CSS Modules + design tokens), imported via `index.css`.
- Tailwind v4 for layout glue only — color tokens (`text-foreground`, `bg-card`), flex/grid, spacing.
- **No typography Tailwind classes app-wide.** `text-xs`/`font-medium`/`tracking-*`/`leading-*`/`uppercase` are forbidden. Body baseline (15 px Geist, 1.5 line-height) drives everything; component-level overrides come from `@armada/ui` CSS Modules. This was a deliberate strip in PR #271 — same convention.

### 4.9 Conventions (enforced/planned)

- All source files start with two-line `// ABOUTME:` headers (project-wide).
- No `ethers` or `@railgun-community/*` imports inside `components/**` — components are dumb, hooks own logic. Planned ESLint rule.
- TS strict + `noUncheckedIndexedAccess` (stricter than the crowdfund apps).
- No `any`, no `as any`. Narrow at module boundaries.
- One concern per hook. One module per concern in `lib/`.
- Per-folder `CLAUDE.md` for future maintainers (8 docs across the scaffold).

---

## 5. Planned functionality (feature roadmap, one feature ≈ one PR)

Reordered per reviewer rec #13: yield validates the lifecycle abstraction on low-risk ground before tackling xchain (highest-risk orchestration); history is moved earlier so it's usable while debugging xchain work; payments split into same-chain vs xchain because the complexity differs meaningfully.

| # | Pass | Builds | Lights up |
|---|---|---|---|
| 1 | **Wallet unlock flow** | Railgun mnemonic generate-on-first-run, passphrase prompt, encrypted IDB blob, 15-min inactivity lock, export/reset settings UI. KEK/DEK separation for future WebAuthn wrap. Memory zeroization discipline. | All other passes; nothing else can work without an unlocked Railgun wallet |
| 2 | **Balances** | Multi-chain unshielded USDC polling + shielded balance subscription via Railgun SDK + yield share read | Dashboard balance card, History header context |
| 3 | **Shield (deposit)** | `shield` TxKind end-to-end: fee quote → build proof → submit to relayer → wait for hub event → settle. Real `useFees` (with fee validator from `lib/relayer/validation.ts`), real proof generation, first real `StageHandler` registered with the executor | Dashboard "Deposit" action |
| 4 | **Unshield local** | `unshield-local` TxKind end-to-end — same shape as shield, opposite direction | Dashboard "Withdraw" (to hub) |
| 5 | **Yield deposit/withdraw** | `yield-deposit` + `yield-withdraw` TxKinds, yield-rate polling + event-driven refresh. **Validates the lifecycle abstraction in low-risk territory before xchain.** | Dashboard Earn panel |
| 6 | **History UI hardening** | TxHistoryList + TxStatusChip + TxLifecycleStepper, filters (kind, executionState), retry actions on expired records. **Lands BEFORE xchain so it's usable while debugging cross-chain flows.** | History page |
| 7 | **Unshield cross-chain** | Full 7-stage `unshield-xchain` flow with Iris polling, CCTP message extraction, destination-chain mint detection. **First use of the long-poll `lib/tx/poller.ts` against Iris.** | Dashboard "Withdraw to another chain" |
| 8 | **Payments (shielded → shielded)** | `transfer-shielded` TxKind, 0zk recipient input + validation | Dashboard "Send privately" |
| 9 | **Payments (shielded → external EVM, xchain)** | `payment-xchain` TxKind — atomic unshield + bridge + send via hook router (assumes contract supports the composition; confirm before building UI) | Dashboard "Send to wallet" |
| 10 | **Address book** | Named-address CRUD (locally encrypted, recipient autofill in payment flows) | AddressBook page in nav |
| 11 | **Production hardening** | Bundle manifests at build time, require explicit RPC env vars in non-local mode, add telemetry sink (Sentry/PostHog), accessibility pass (jsx-a11y), code splitting for Railgun WASM, cross-tab live sync if multi-tab UX demands it | Sepolia + mainnet deployments |

---

## 6. Open questions

These don't block scaffolding (already done). They block specific feature passes — listed roughly in the order they need answering.

Several originally-listed questions were **resolved by the reviewer pass** and are no longer open: per-kind expiry (resolved → §4.2), fee sanity check (resolved → `lib/relayer/validation.ts`), multi-wallet semantics (resolved → plural schema in §4.3), Railgun WASM loading (resolved → engine warmup atom). What remains:

### 6.1 Mnemonic + key storage UX details

- **Recovery-phrase confirmation step:** v1 generates a mnemonic and stores it encrypted; do we also force the user to confirm the phrase by re-entering it (typical wallet UX) before letting them proceed? Or "see and confirm" once is enough?
- **Inactivity timeout configurability:** 15 min default. Surfaced in Settings? Stored where (IDB)?
- **Browser-data-clear scenario:** encrypted IDB blob destroyed → mnemonic unrecoverable unless exported. Is export-on-creation **required** before the user can proceed, or merely offered with a "you may regret this" warning?

### 6.2 Tx idempotency on the wire

- We generate a ulid client-side and use it as the `TxRecord.id`. The relayer dedups by `to + data + nonce` — not by our id. If a user clicks "Submit" twice quickly before the first request returns, we want no double-submission.
- **Plan:** client-side submit lock (button disabled until response) + trust the relayer's dedup window as backup. Confirm both layers are in play during Pass 3 (shield) implementation.

### 6.3 Cross-chain payment routing

- A "shielded → external EVM on another chain" could be modeled as either one `payment-xchain` (atomic unshield + bridge + send via hook router) or `unshield-local` followed by a separate xchain step (two records, sequential).
- **Current plan:** one `payment-xchain` TxKind with the 7-stage lifecycle, assuming the hook router handles the composition atomically. **Confirm the relayer/contract actually supports this** before building UI for it (blocks Pass 9).

### 6.4 Indexer specifics

- The optional-tier pattern is in place via `lib/events/{RpcEventSource, IndexerEventSource}` (rec #8). RPC implementation is stubbed; indexer implementation is fully stubbed.
- **Open:** what does the indexer actually provide? Does an indexer for privacy-pool events exist yet, or do we wait for one to be built? Without it, does RPC log-fetching scale to the volumes we expect (>10k events on a busy testnet)?
- **Open:** if indexer is set but unavailable at runtime, fall back to RPC and show a `<StaleDataBanner>` indicating degraded mode. Same pattern as the committer.

### 6.5 Telemetry sink

- Console-only for v1 is decided. **When do we switch to a real sink (Sentry / PostHog)?** Before mainnet? Before sepolia public access? Never (privacy focus)?
- The typed `EventRegistry` (rec #12) ensures we won't accidentally leak when we do swap — the registry itself is the privacy review surface.

### 6.6 Mobile

- Plan §15: "Mobile-aware from day one". Header collapses via `sm:` breakpoint but no mobile sheet / hamburger is wired in armada-interface yet (committer has one).
- **Open:** is mobile a v1 target? Or desktop-first, mobile sheet later? Affects whether the next feature pass needs to consider mobile layout for tx modals.

### 6.7 Accessibility budget

- Decision 19: `eslint-plugin-jsx-a11y` from day one. **Not yet installed.** Add as part of Pass 1 (wallet unlock) or 3 (shield) since those introduce the first real form UI.
- **Open:** target accessibility standard (WCAG 2.1 AA)? Privacy apps are often used by power users with assistive tech; this matters.

### 6.8 Cross-tab UX

- Leader election (rec #9) is in place via `navigator.locks` — only the leader tab runs the executor. Follower tabs are passive observers.
- **Open:** what does the user see on a follower tab? Currently their pages render with stale data and no warning. Recommend adding a thin "another tab is active" banner before mainnet. Not v1-critical.

### 6.9 Production rollout

- No production target defined. Feature passes 1–10 can land regardless. **Pass 11 (production hardening) needs a real target before it starts.**
- Eventual mainnet deployment requires: privacy-pool contracts deployed, real Iris (not sandbox), real Aave on mainnet, real CCTP. Coordination with contracts/relayer teams.

---

## 7. Things explicitly out of scope (for the foreseeable future)

- Mnemonic import flow (decided: generate-on-first-run only for v1).
- e2e testing infrastructure (Playwright). Manual + unit + integration only for now.
- Real telemetry sink. Console structured logs only.
- Service worker / offline support.
- i18n.
- Hardware wallet edge cases beyond what wagmi covers out of the box.
- A "swap" feature (USDC ↔ other assets). Pool supports any asset; this app stays USDC-only.

---

## 8. References

- **Detailed plan:** `.claude/PLAN_ARMADA_INTERFACE.md`
- **Sibling design system plan:** `.claude/PLAN_ARMADA_UI_FOUNDATION.md`
- **Root architecture notes:** `.claude/ARCHITECTURE_NOTES.md`
- **Project conventions:** `CLAUDE.md` (root) — has the "ABOUTME header" rule, secret-handling rules, simplifying-assumption convention.
- **Scaffold PR:** #272 — the current state.
- **Sibling app for pattern reference:** `crowdfund-ui/packages/committer/` — same provider tree, same RPC fallback, same indexer-optional pattern.

---

## 9. What I want from a review

Pointed questions a reviewing agent could usefully answer:

1. **Tx lifecycle model (§4.2):** is the discriminated-union-per-kind approach the right level of abstraction, or does this beg for XState? I chose against XState because the lifecycles are small enough that a reducer + lifecycle table is more grokkable. Push back if you disagree.
2. **Per-kind expiry caps (§6.7):** is a single 30-min cap dangerous, or fine for v1?
3. **Multi-wallet semantics (§6.6):** the "one Railgun wallet per app install, independent of EVM wallet" default — is that the right call?
4. **Fee sanity check (§6.4):** worth it, or premature?
5. **Indexer optionality (§6.5):** is the optional-tier pattern (with RPC fallback) good enough for an app that may have to read thousands of shielded-pool events, or does this app's volume make indexer non-optional eventually?
6. **Are there obvious gaps?** I'm most worried about something architectural that's hard to retrofit (e.g. "you can't fix tx persistence after the fact" — already handled, but what else might fall in that category?).
7. **Anything in the planned roadmap (§5) you'd reorder?** Especially passes 5 (xchain unshield) vs 6 (yield) vs 8 (xchain payments). Xchain is the highest-risk pass.

End of overview.
