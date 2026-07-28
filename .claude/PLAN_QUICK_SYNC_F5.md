# PLAN: F5 — Frontend Quick-Sync Adoption (armada-interface)

<!-- ABOUTME: Self-contained handoff plan to wire the frontend Railgun engine to the relayer-v2 -->
<!-- ABOUTME: watcher quick-sync endpoint, with on-chain merkleroot + nullifier safety gates. -->

> **Status:** Ready to implement. This is the "F5" row of `.claude/PLAN_EVENT_INDEXING.md` §7
> (Phase 4) and `specs`/relayer-v2 §18. The relayer-v2 watcher endpoint it depends on is
> **already built** (`GET /v1/quick-sync/:chainId`). This plan is written to be executed by an
> agent with no prior context on this thread — all facts are inlined with `file:line` refs.
> Author: A.W.E.S.O.M.-O 4000, 2026-07-28.

---

## 0. TL;DR for the implementer

Today the frontend boots the Railgun engine via the wallet-SDK convenience
`startRailgunEngine(...)` (`apps/armada-interface/src/lib/railgun/init.ts:219`). That wrapper
**hardcodes** the quick-sync source (`quickSyncEventsGraph`) and merkleroot validators — there is
no override parameter. To hydrate the wallet's merkletree from our own watcher instead of an
O(chain-length) event scan, we must call the **low-level** `RailgunEngine.initForWallet(...)`
ourselves, passing a custom `quickSyncEvents` callback, then register that engine with the wallet
SDK via `setEngine(engine)` so every other convenience (wallet create/load, balances, provider
loading) keeps working unchanged.

Two hard safety requirements gate shipping (do **not** ship without them):
- **Merkleroot validation** — a malicious/buggy watcher must only be able to cause *sync failure*,
  never *forged balances*. The chain stays the root of trust.
- **Nullifier cross-check** — root validation cannot catch an *omitted* `Nullified` event (an
  already-spent note shown as unspent → inflated displayed balance). A separate on-chain
  cross-check closes that gap before the spend gate opens.

Estimated size: **M–L**, best split into 3 PRs (see §9).

---

## 1. Background — what "quick sync" is and why F5 exists

The Railgun engine keeps a client-side merkletree of shielded commitments. A cold wallet must
populate that tree. Two ways:
- **Slow scan (today):** the engine calls `eth_getLogs` against the PrivacyPool from the
  deploy block to head. Once-per-device (persisted in IndexedDB), but O(chain-length).
- **Quick sync (F5):** one paginated HTTP fetch of the engine's `AccumulatedEvents`
  (commitments + unshields + nullifiers) from our relayer-v2 **watcher**, which pre-indexed them.

There are **two distinct "quick sync" mechanisms** — do not confuse them:
1. **Railgun SDK's built-in quick sync** (`quickSyncEventsGraph`) — pulls from Railgun's *own*
   graph nodes for real networks. The frontend currently **suppresses** this by masquerading as
   `NetworkName.Hardhat` (see §4.3) because it would download the *real* Railgun deployment's
   history, which doesn't match our POC pool.
2. **Our watcher's quick sync** (this plan) — the relayer-v2 watcher serves the *same engine
   `AccumulatedEvents` shape* but decoded from **our** PrivacyPool's logs. F5 injects this as the
   engine's quick-sync source, replacing both the slow scan and the need for #1's suppression.

---

## 2. The backend contract (already built — for reference only)

Repo: `ship-armada/armada-relayer`, path `relayer-v2/watcher/`. **No work needed here**; F5 consumes it.

```
GET  {indexerUrl}/v1/quick-sync/{chainId}?startingBlock={N}
```
- **Hub chain only** (all Railgun events live on the hub pool). `chainId` must equal the hub's.
- **Response** (engine `@railgun-community/engine` **9.5.1** `AccumulatedEvents` shapes + pagination):
  ```jsonc
  {
    "commitmentEvents": [ /* CommitmentEvent[] — Shield + Transact, block/log ordered */ ],
    "unshieldEvents":   [ /* UnshieldStoredEvent[] */ ],
    "nullifierEvents":  [ /* Nullifier[] */ ],
    "servedThroughBlock": 12345,   // pagination cursor (whole blocks; never splits an event)
    "indexedThrough":     20000    // highest fully-indexed hub block
  }
  ```
- **Pagination:** start at `startingBlock` = the wallet's creation/deploy block; on each response
  continue with `startingBlock = servedThroughBlock + 1` **until `servedThroughBlock === indexedThrough`**.
  Server bounds each page to `QUICK_SYNC_MAX_BLOCK_WINDOW` (default 100k) blocks.
- **Caching:** closed historical ranges return `Cache-Control: public, max-age=86400, immutable`;
  near-head returns `max-age=5`. Safe to let the browser/CDN cache.
- **Type pin (B3):** the watcher's decode is compile-time pinned to engine **9.5.1** — the exact
  version the frontend ships (`package.json`: `@railgun-community/engine` `9.5.1`,
  `@railgun-community/wallet` `10.8.1`). If the frontend bumps the engine, the watcher's type test
  must be re-pinned in the same change window (coordinate the two repos' PRs).

Reference source in the relayer repo: `relayer-v2/watcher/src/api/quick-sync.ts` (response types +
builder), `relayer-v2/watcher/src/api/index.ts` (`app.get("/v1/quick-sync/:chainId", …)`).

---

## 3. The SDK architecture that makes this possible (verified in `node_modules`)

### 3.1 `startRailgunEngine` is just `initForWallet` + `setEngine`
`node_modules/@railgun-community/wallet/dist/services/railgun/core/init.js` — the entire body:
```js
const engine = await RailgunEngine.initForWallet(
  walletSource, db, artifactGetterDownloadJustInTime,   // ← internal artifact getter (NOT exported)
  quickSyncEventsGraph,                                 // ← HARDCODED graph quick-sync
  quickSyncRailgunTransactionsV2,                       // ← HARDCODED (TXID/POI)
  WalletPOI.getPOITxidMerklerootValidator(poiNodeURLs), // ← POI TXID validator
  WalletPOI.getPOILatestValidatedRailgunTxid(poiNodeURLs),
  shouldDebug ? createEngineDebugger(...) : undefined,
  skipMerkletreeScans);
setEngine(engine);
setOnUTXOScanDecryptBalancesCompleteListener();
// + optional WalletPOI.init(...) when poiNodeURLs is defined
```

### 3.2 The `setEngine` seam — why we keep every other convenience
`node_modules/@railgun-community/wallet/dist/services/railgun/core/engine.js` holds a
module-level singleton:
```js
let savedEngine;
const getEngine = () => { if (!savedEngine) throw ...; return savedEngine; };
const setEngine = (engine) => { savedEngine = engine; };
```
**12** wallet-SDK modules (`load-provider.js`, `balances.js`, `prover.js`, `merkletree.js`,
`shields.js`, …) resolve the engine via `getEngine()`. So if we call `initForWallet` ourselves and
then `setEngine(engine)`, all of these keep working against **our** engine (with our quick-sync
source). `setEngine` is reachable from app code: `index.d.ts` → `services` → `railgun` → `core` →
`export * from './engine'`.

### 3.3 The engine `initForWallet` signature (arg order — preserve exactly)
`node_modules/@railgun-community/engine/dist/railgun-engine.d.ts:51`:
```ts
static initForWallet(
  walletSource: string,
  leveldown: AbstractLevelDOWN,
  artifactGetter: ArtifactGetter,
  quickSyncEvents: QuickSyncEvents,                      // ← WE INJECT the watcher client here
  quickSyncRailgunTransactionsV2: QuickSyncRailgunTransactionsV2,
  validateRailgunTxidMerkleroot: MerklerootValidator,    // TXID tree (POI) — stub ok (POI dummied)
  getLatestValidatedRailgunTxid: GetLatestValidatedRailgunTxid, // stub ok
  engineDebugger: Optional<EngineDebugger>,
  skipMerkletreeScans?: boolean                          // keep FALSE (scanning enabled)
): Promise<RailgunEngine>;
```
Callback types (from `@railgun-community/engine`):
```ts
type QuickSyncEvents = (txidVersion: TXIDVersion, chain: Chain, startingBlock: number) => Promise<AccumulatedEvents>;
type QuickSyncRailgunTransactionsV2 = (chain: Chain, latestGraphID?: string) => Promise<RailgunTransactionV2[]>;
type MerklerootValidator = (txidVersion: TXIDVersion, chain: Chain, tree: number, index: number, merkleroot: string) => Promise<boolean>;
type GetLatestValidatedRailgunTxid = (txidVersion: TXIDVersion, chain: Chain) => Promise<{ txidIndex?: number; merkleroot?: string }>;
```

### 3.4 The in-repo precedent — `lib/sdk/init.ts`
The Node side already uses `RailgunEngine.initForWallet(...)` (`lib/sdk/init.ts:235-267`) with a full
`ArtifactGetter` (`:134-138`), quick-sync stubs (`:146-199`), and `engineDebugger` (`:206-222`).
It loads the network at engine level via `engine.loadNetwork(chain, proxyAddress, …)`
(`lib/sdk/network.ts:152-213`) — passing the PrivacyPool address **explicitly**, which is why the
Node side needs **no** `NetworkName.Hardhat` masquerade. This file is the direct template for the
browser port; the only deltas are DB backend (browser already uses level-js/IndexedDB) and
artifact byte-source (fetch vs `fs`).

### 3.5 ⚠️ The one real constraint on the minimal approach
`artifactGetterDownloadJustInTime` (the wallet SDK's internal IPFS-download artifact getter that
`overrideArtifact` writes into) is **NOT exported** — the artifacts barrel only exports
`artifact-downloader` + `artifact-store`
(`node_modules/@railgun-community/wallet/dist/services/artifacts/index.d.ts`). So when we call
`initForWallet` ourselves we **must supply our own `ArtifactGetter` (arg 3)**. This is the single
piece beyond the quick-sync callback that we must own. See WI-1 step 3 for the resolution.

---

## 4. Current frontend state (what we're changing)

### 4.1 Engine bootstrap — `apps/armada-interface/src/lib/railgun/init.ts`
- `doInit()` (`:165-288`): dynamic-imports `{ startRailgunEngine, setLoggers,
  setOnUTXOMerkletreeScanCallback, overrideArtifact }`; builds `db = createWebDatabase('armada-shielded')`
  (`:216`, level-js/IndexedDB) and `artifactStore = await createBrowserArtifactStore()` (`:217`).
- `startRailgunEngine(...)` (`:219-229`) — 9 args, `skipMerkletreeScans = false` (`:224`).
- `overrideArtifact` (`:239-241`, DEV only) loads 20 Armada circuit shapes from the Vite dev
  middleware into the SDK artifact cache.
- `setOnUTXOMerkletreeScanCallback` (`:246-263`) maps `MerkletreeScanStatus.{Started,Updated,Complete,Incomplete}`
  → `syncStateAtom`.
- `initializeProver()` (`:269`, `prover.ts:16-39`) then `POI.init([], dummyNodeInterface)` (`:273-287`).
- State machine `'cold'→'warming'→'ready'|'failed'` mirrored into `railgunEngineAtom`.

### 4.2 Wallet-SDK conveniences the app depends on (all keep working via `setEngine`)
| Convenience (`@railgun-community/wallet`) | Where | Keep as-is? |
|---|---|---|
| `setLoggers`, `setOnUTXOMerkletreeScanCallback`, `overrideArtifact` | `init.ts` | yes (re-call after `setEngine`) |
| `getProver` | `prover.ts:29` | yes |
| `loadProvider` | `network.ts:112,172` | yes (see §4.3 decision) |
| `setOnBalanceUpdateCallback` | `sync.ts:40` | yes |
| `refreshBalances` | `sync.ts:75` | yes |
| `balanceForERC20Token` | `sync.ts:88,96` (arg `NetworkName.Hardhat`) | yes (see §4.3) |
| `walletForID` | `sync.ts:88`, `wallet.ts:591` | yes |
| `createRailgunWallet` | `wallet.ts:695` (`creationBlockNumbers={Hardhat:block}`) | yes |
| `loadWalletByID` / `unloadWalletByID` / `deleteWalletByID` | `wallet.ts:337/577/633` | yes |
| `POI.init` (`@railgun-community/engine`) | `init.ts:283` | yes |

**Key point:** because of `setEngine`, F5 does **not** rewrite the wallet lifecycle or balance
reads. It only replaces the ~15-line engine-construction call and owns the ArtifactGetter.

### 4.3 The `NetworkName.Hardhat` masquerade — DECISION: keep it for F5
`network.ts:65-100` (`patchNetworkConfig`) mutates the SDK's in-memory
`NETWORK_CONFIG.Hardhat` entry: sets `proxyContract = privacyPool` (`:78`), deployment block
(`:81`), pins `chain = {type:0, id: hubChainId}` (`:90-91`), and neutralizes the real Sepolia
entry `sepoliaEntry.chain = {type:0, id:-1}` (`:95-96`). `NetworkName.Hardhat` leaks into 5 sites
(`network.ts:27,172`; `sync.ts:99`; `wallet.ts:693,594`).

Two options:
- **(A1 — recommended for F5) Keep the masquerade.** The wallet-SDK conveniences
  (`loadProvider`, `balanceForERC20Token`) look up `NETWORK_CONFIG[NetworkName.Hardhat]`; keeping the
  masquerade lets them work untouched. Quick-sync injection is orthogonal to the network *name* —
  the engine still loads the real PrivacyPool contract via the patched `proxyContract`, so on-chain
  root validation (§WI-4) is unaffected. **Smallest correct change.**
- **(A2 — defer) Remove the masquerade** by loading the network at engine level via
  `engine.loadNetwork(realAddress, …)` (like `lib/sdk`). This forces balance reads to move to
  engine level too (`engine.wallets[id].getTokenBalances`). More surface, no correctness benefit
  for quick sync. **Fold into the SDK-fork work later, not F5.**

Rationale: the masquerade is how the network is *registered*, independent of where quick-sync data
comes from. Once F5 injects our watcher source, the masquerade no longer *suppresses* anything
security-relevant — it's just a network-name alias. Removing it is cleanup best done with the fork.

### 4.4 The events layer & sync gate (touch points)
- **`EventSource`** (`apps/armada-interface/src/lib/events/EventSource.ts:38-45`):
  `getCommitments(range)`, `getNullifiers(range)`, `getTxHistory(address, range)`. `RawNullifier`
  (`:16`) = `{ blockNumber, txHash, logIndex, hash }`. `IndexerEventSource` throws (`:13-23`),
  `RpcEventSource` returns `[]` (`:16-29`); factory `index.ts:22-29` picks indexer when
  `indexerUrl` set. **Note:** F5's quick-sync client is a *sibling* of this layer (it hits the
  `/v1/quick-sync` endpoint returning `AccumulatedEvents`, not the `/v1/commitments` `Raw*` stream).
  Do **not** overload `EventSource` for it.
- **Sync gate** — `hooks/useSpendableSyncGate.ts:33-52`: pure atom reader returning
  `{ blocked, reason }`. Blocks on `syncStateAtom.status === 'failed'` (`:37`) and on
  `'syncing' && shieldedUsdcAtom === null` (`:44`); **opens at `:51`**. Consumed by
  `SendModal.tsx:78`, `EarnModal.tsx:73`, `UnshieldModal.tsx:72` (disable Confirm + show `reason`).
  `syncStateAtom` defined `state/wallet.ts:67-79`. **This `:51` open-return is where the nullifier
  cross-check inserts a new blocked branch** (§WI-5).
- **Config** — `config/network.ts`: `indexerUrl` (`:23,141,155`) = `VITE_INDEXER_URL ?? null`
  (both modes null today → factory picks RPC). Hub chainId local `31337` / sepolia `11155111`.
  `maxLogRange` local `100_000` / sepolia `5_000`. **No `deployBlock` here** — it comes from
  deployment manifests (`config/deployments.ts`), anchored by `resolveCreationBlock` in `lib/railgun/`.

---

## 5. The chosen approach (resolves the "engine-port gate")

The `.claude/PLAN_EVENT_INDEXING.md` §7 gate asks: (a) do the engine-level port now, (b) defer, or
(c) hope a newer wallet SDK exposes an override. **Recommendation: (a), via the `setEngine` seam
(A1).** Justification, now grounded in the SDK source:
- (c) is out — wallet SDK 10.8.1 has no quick-sync override (§3.1).
- (b) defer is viable short-term (cold scan is once-per-device, IndexedDB-persisted, `deployBlock`-bounded)
  but the watcher endpoint is already built and waiting; the win is real once history grows.
- (a) is **much smaller than the plan feared** because `setEngine` lets us keep the entire wallet
  lifecycle + balance path on the wallet SDK. We only own: the `initForWallet` call, the
  `ArtifactGetter` (forced by §3.5), the quick-sync client, and the two safety checks.

**Rejected — Approach C (monkey-patch):** call `startRailgunEngine` as today, then reassign
`(engine as any).quickSyncEvents`. Rejected: `quickSyncEvents` is `readonly` (engine `.d.ts:32`),
the reassignment is fragile across SDK versions, and it's exactly the kind of workaround we're
trying to eliminate. Do not do this.

---

## 6. Work items (TDD — write the failing test first for each)

> Ordering: WI-1 and WI-2 are the enabling core; WI-4/WI-5 are the **ship-blocking** safety gates;
> WI-3 (server decode) is already done in the watcher. WI-6 is config/degrade.

### WI-1 — Engine-port: `initForWallet` + `setEngine` (replaces `startRailgunEngine`)
**File:** `apps/armada-interface/src/lib/railgun/init.ts` (the `doInit()` body, `:219-229`).
**Steps:**
1. Change the dynamic import to pull `{ setEngine, setLoggers, setOnUTXOMerkletreeScanCallback,
   overrideArtifact, getProver }` from `@railgun-community/wallet` and `{ RailgunEngine, POI }`
   from `@railgun-community/engine`.
2. Replace the `startRailgunEngine(...)` call with:
   ```ts
   const engine = await RailgunEngine.initForWallet(
     ENGINE_WALLET_SOURCE, db as never, artifactGetter,   // arg 3: OUR getter (step 3)
     quickSyncEventsClient,                                // arg 4: WI-2
     quickSyncRailgunTransactionsV2Stub,                  // arg 5: async () => []
     txidMerklerootValidatorStub,                         // arg 6: async () => true  (POI dummied)
     getLatestValidatedRailgunTxidStub,                   // arg 7: async () => ({txidIndex:undefined, merkleroot:undefined})
     engineDebugger, false /* skipMerkletreeScans */);
   setEngine(engine);
   ```
   Keep `ENGINE_WALLET_SOURCE = 'armadainf'` (`init.ts:19`) and the same `db`/`artifactStore`.
3. **ArtifactGetter (arg 3) — required (§3.5).** First verify whether
   `@railgun-community/wallet`'s `artifact-downloader` barrel re-exports a usable
   download-just-in-time getter. If yes, use it + `setArtifactStore(artifactStore)` +
   `setUseNativeArtifacts(false)`. **If not** (expected), build an `ArtifactGetter`
   (`{ assertArtifactExists, getArtifacts, getArtifactsPOI }`) that reads the existing
   `createBrowserArtifactStore()` IndexedDB store, and route the DEV Armada-circuit overrides
   (`loadArmadaCircuits`, `init.ts:123-163`) through *that* store instead of `overrideArtifact`.
   Template: `lib/sdk/init.ts:81-138` (`getArtifacts`/`getArtifactsPOI`/`assertArtifactExists`);
   adapt byte-source from `fs` to the browser store's `get`.
4. Re-call the app's existing setup **after `setEngine`**: `setLoggers(...)` (keep the
   `isBenignEngineEventNoise` filter, `init.ts:188-190`), `setOnUTXOMerkletreeScanCallback(...)`
   (`init.ts:246-263`), `initializeProver()` (`prover.ts`), `POI.init([], dummyNodeInterface)`.
5. **Verify:** whether the internal `setOnUTXOScanDecryptBalancesCompleteListener()` that
   `startRailgunEngine` calls is needed for a balance-complete signal. It's POI-batching related
   and likely unnecessary with POI off — but confirm balances still populate; if a gap appears,
   find the exported equivalent or the engine event to subscribe.
**Tests:** unit — engine boots to `ready`, `railgunEngineAtom` transitions cold→warming→ready;
`getEngine()` returns the instance; a wallet create/load + `balanceForERC20Token` still works
(i.e. the `setEngine` seam holds). Mock the SDK where the existing `init` tests do.
**Done when:** the app boots and shields/loads a wallet with **zero** behavioral change vs today
(quick sync not yet pointed at the watcher — arg 4 can start as the empty-`AccumulatedEvents` stub
so this WI is independently shippable/testable).

### WI-2 — Quick-sync client (`quickSyncEvents` → `GET /v1/quick-sync`)
**New file:** `apps/armada-interface/src/lib/railgun/quickSync.ts`.
**Behavior:**
- Signature matches `QuickSyncEvents`: `(txidVersion, chain, startingBlock) => Promise<AccumulatedEvents>`.
- Resolve base URL from `getNetworkConfig().indexerUrl`. **If `null` → return empty
  `{ commitmentEvents: [], unshieldEvents: [], nullifierEvents: [] }`** (= fall back to slow scan;
  satisfies B4, §WI-6). Also return empty if `chain.id !== hub chainId` (endpoint is hub-only).
- Paginate: loop `GET {indexerUrl}/v1/quick-sync/{hubChainId}?startingBlock={cursor}`, accumulate
  the three arrays, advance `cursor = servedThroughBlock + 1`, stop when
  `servedThroughBlock === indexedThrough`. Guard against non-advancing cursor (defensive: break if
  `servedThroughBlock < cursor`). Honor an abort/timeout.
- **Strict validation** on every page: shape-check each event against the engine 9.5.1
  `AccumulatedEvents` fields before handing to the engine; on ANY fetch/parse/validation failure,
  log + return the empty result (→ slow scan). Never throw out of the callback (a throw would break
  engine init).
**Tests:** unit — (a) happy path assembles multi-page result and stops at `indexedThrough`;
(b) `indexerUrl` null → empty; (c) network error mid-pagination → empty (fallback); (d) malformed
page → empty; (e) non-hub chain → empty. Use a fetch mock.
**Wire into WI-1** as arg 4.

### WI-3 — Server-side decode — **DONE (external)**
The watcher already decodes stored raw hub logs into engine `AccumulatedEvents`
(`relayer-v2/watcher/src/api/quick-sync.ts`) with a compile-time engine-9.5.1 type pin and a
ground-truth deep-equal test. **No frontend work.** Only obligation: keep engine version in lockstep
(B3) — if you bump `@railgun-community/engine`, open a paired watcher PR to re-pin.

### WI-4 — Merkleroot validation (SHIP-BLOCKING; item 3)
**Threat:** a malicious watcher feeds bad commitments → the wallet's rebuilt merkletree would show
forged balances. **Defense:** the engine's **UTXO commitment merkletree** validates every rebuilt
root against the on-chain `rootHistory` of the loaded PrivacyPool contract, so bad data → root
mismatch → sync fails (never forged).
**On-chain getter (verified):** `PrivacyPoolStorage.sol:145-146`
`mapping(uint256 => mapping(bytes32 => bool)) public rootHistory;` → auto getter
`rootHistory(uint256 treeNumber, bytes32 root) view returns (bool)` on the PrivacyPool address
(`deployments.hub.contracts.privacyPool`). Set in `MerkleModule.sol:157`. The engine's own
`RailgunSmartWalletContract.validateMerkleroot(tree, root)` already calls exactly this
(`node_modules/@railgun-community/engine/dist/contracts/railgun-smart-wallet/V2/railgun-smart-wallet.js:74-83`).
**⚠️ Verify-first (do this before writing code):** determine whether the engine's UTXO merkletree
*already* validates against `rootHistory` automatically once the network is loaded with the real
PrivacyPool address + hub provider (it should — the merkletree consumes the loaded contract's
`validateMerkleroot`). Two outcomes:
- **If automatic:** WI-4 is mostly *proving* it via the adversarial test below + ensuring the real
  contract/provider is loaded (it is, via the masquerade's `proxyContract` + `loadProvider`).
  **Note:** the `initForWallet` **arg-6** `MerklerootValidator` is the *TXID* tree (POI) validator,
  NOT the UTXO tree — leaving it a stub is correct; do not wire `rootHistory` into arg 6 (category error).
- **If NOT automatic** in this engine version: add an explicit post-quick-sync UTXO-root check that
  calls `rootHistory(treeNumber, root)` on the hub PrivacyPool (raw `ethers.Contract` via the hub
  provider — see WI-5 for the provider helper) and refuses/rolls back the ingested tree on mismatch.
**Tests (the real acceptance gate — write these regardless of mechanism):** adversarial — feed a
quick-sync response with **one mutated commitment**; assert the wallet's sync ends in `failed`
(root mismatch) and the corrupted data does **not** poison the persisted IndexedDB tree, and the app
falls back to slow scan. Integration — a fresh wallet synced via quick-sync vs. via slow scan must
produce **identical merkle roots and balances** on the local stack.

### WI-5 — Nullifier cross-check (SHIP-BLOCKING; item 4)
**Threat root-validation can't catch:** nullifiers are **not** in the commitment merkletree, so a
watcher that serves commitments faithfully but **omits** a `Nullified` event passes root validation
while making an already-spent note look **unspent** → inflated *displayed* balance (never spendable —
the chain rejects the double-spend — but wrong/misleading UX and a potential footgun).
**On-chain getter (verified):** `PrivacyPoolStorage.sol:148-149`
`mapping(uint256 => mapping(bytes32 => bool)) public nullifiers;` → auto getter
`nullifiers(uint256 treeNumber, bytes32 nullifier) view returns (bool)` on the PrivacyPool address.
Set in `TransactModule.sol:359-360`. **No SDK read helper exists — raw `eth_call` required.**
**Implementation:**
1. New helper (in `lib/railgun/`, per app layering) using a raw `ethers.Contract(privacyPool,
   ['function nullifiers(uint256,bytes32) view returns (bool)'], hubProvider)`. Reuse the existing
   hub provider pattern: `timeoutProvider(url)` + `getNetworkConfig().hub.rpcUrls`
   (`network.ts:38,198`).
2. For each of the user's **own unspent** UTXOs (from `engine.wallets[id].getTokenBalances(...,
   onlySpendable=true)` — verify how to obtain each note's `(treeNumber, nullifier)`; the engine
   holds the nullifying key and computes nullifiers for own notes — locate the getter or compute via
   the engine's note logic), call `nullifiers(treeNumber, nf)`. If on-chain says **spent** while the
   note is locally unspent → the watcher omitted the event → mark the sync as needing a full rescan
   and **block the spend gate**.
3. **Gate insertion:** add a new blocked branch in `hooks/useSpendableSyncGate.ts` **before the
   `:51` open-return**, reading a new atom (e.g. `nullifierCrossCheckAtom`) that a new hook writes
   after quick-sync completes (mirror the `useShieldedBalanceSync` atom-writing pattern; the gate
   hook must stay a pure atom reader — no effects in it).
4. **Privacy decision (DECIDE + DOCUMENT):** pre-querying your own nullifiers lets the RPC provider
   link them to your IP when later spent on-chain. Options: (i) batch via multicall mixed with
   **decoy** nullifiers sampled from the global stream; (ii) accept the leak (it's to the RPC
   provider, matching today's exposure). **Recommendation:** accept for **testnet** (matches current
   exposure, unblocks shipping); implement decoy-multicall as a **mainnet** follow-up. Record the
   decision in code + `SECURITY.md` (P6 residual leak).
**Tests:** unit — spent note flagged (on-chain true, local unspent → blocked); unspent note passes.
Adversarial — a quick-sync response with valid commitments but **one dropped `Nullified` event**
must pass root validation (WI-4) yet be **caught here** before the gate opens. This case is *not*
catchable by root validation — this cross-check test is the only line of defense; make it explicit.

### WI-6 — Config, degradation & rollout (B4)
- `VITE_INDEXER_URL` is already plumbed (`config/network.ts:23,141`). No config schema change.
- **B4 invariant (acceptance criterion):** with `VITE_INDEXER_URL` **unset**, the app MUST be fully
  functional — WI-2 returns empty → slow scan; WI-4/WI-5 gates operate on the slow-scan tree
  identically. Add a test asserting boot + sync + spend work with `indexerUrl = null`.
- Docs: update `apps/armada-interface/src/lib/railgun/CLAUDE.md` (engine now boots via
  `initForWallet`), `lib/events/CLAUDE.md` if the quick-sync client lands near it, and note the
  Netlify `VITE_INDEXER_URL` env for sepolia builds. Flag the VPS/relayer nothing here (frontend-only).

---

## 7. Local testing recipe (answers "how do I test quick sync locally")

Per `.claude/PLAN_EVENT_INDEXING.md` §8.1 (Phase 4) and relayer-v2 §15.2/§15.3:
1. **Local chains + contracts:** in this monorepo, `npm run chains` then `npm run setup` (Anvil hub
   :8545 + deployed PrivacyPool + local manifests in `deployments/`).
2. **Generate history:** run shield/transact/unshield flows (existing Hardhat helpers, or the
   xchain e2e tests) so the hub PrivacyPool emits `Shield`/`Transact`/`Nullified`/`Unshield` events.
3. **Stand up the watcher against local chains:** in `ship-armada/armada-relayer`,
   `npm run relayer-v2` (docker compose: postgres + watcher + actor) with `NETWORK=local` and
   `DEPLOYMENTS_DIR` pointed at this repo's `deployments/`; or `npm run watcher:dev`. Confirm
   `GET localhost:42069/v1/quick-sync/31337?startingBlock=0` returns non-empty arrays and paginates.
4. **Point the frontend at it:** run armada-interface with `VITE_INDEXER_URL=http://localhost:42069`
   and `VITE_NETWORK=local`.
5. **Differential test (the load-bearing check):** sync a **fresh** wallet (clear IndexedDB) once
   with `VITE_INDEXER_URL` set (quick sync) and once unset (slow scan); assert **identical merkle
   root + shielded balance**. This is the WI-4 integration test at the UI level.
6. **Adversarial (WI-4/WI-5):** with a test double or a locally-patched watcher, serve (a) a mutated
   commitment → assert sync `failed` + IndexedDB not poisoned + fallback; (b) a dropped `Nullified`
   event → assert root validation passes but the nullifier cross-check blocks the spend gate.
7. **e2e:** full xchain-unshield through the UI against the compose stack, indexer-on vs indexer-off
   parity (relayer-v2 §15.3).

---

## 8. Risks & verify-at-start checklist

- [ ] **R1 (pivotal): ArtifactGetter export.** Confirm whether `@railgun-community/wallet` exports a
      reusable download-just-in-time getter (`artifact-downloader` barrel). If not (expected),
      implement our own reading `createBrowserArtifactStore()` + reroute Armada overrides (WI-1.3).
      This is the biggest unknown; resolve it first — it determines WI-1's size.
- [ ] **R2: Auto UTXO-root validation.** Confirm the engine validates the UTXO merkletree root
      against on-chain `rootHistory` automatically once the network is loaded (WI-4 verify-first).
      Do **not** mis-wire `rootHistory` into the arg-6 TXID validator.
- [ ] **R3: Own-note nullifier derivation.** Confirm how to get each own unspent note's
      `(treeNumber, nullifier)` from the engine wallet (WI-5.2).
- [ ] **R4: `setOnUTXOScanDecryptBalancesCompleteListener`.** Confirm balances still populate
      without the internal listener `startRailgunEngine` calls (WI-1.5).
- [ ] **R5: engine version lockstep (B3).** Any `@railgun-community/engine` bump needs a paired
      watcher type-pin PR.
- [ ] **R6: masquerade decision.** Confirm A1 (keep masquerade) with the reviewer; A2 removal is a
      separate/fork task, explicitly out of F5 scope.

---

## 9. Suggested PR breakdown

1. **PR-1 (WI-1 + WI-6 skeleton):** engine-port to `initForWallet` + `setEngine`, own the
   ArtifactGetter, arg-4 = empty stub. Zero behavior change (still slow-scan). Independently
   shippable + reversible. Includes the B4 "unset" test.
2. **PR-2 (WI-2 + WI-4):** quick-sync client wired to arg 4 + merkleroot-validation proof
   (adversarial + differential tests). Quick sync now works and is safe against forged balances.
3. **PR-3 (WI-5):** nullifier cross-check + gate insertion + privacy decision doc. Closes the
   omission gap. **Only after PR-3 may quick sync be enabled by default on sepolia**
   (set `VITE_INDEXER_URL`), per the §7 "MUST NOT ship without root validation + nullifier
   cross-check" gate.

---

## 10. References (all in this repo unless noted)

- `.claude/PLAN_EVENT_INDEXING.md` §7 (Phase 4) — authoritative safety-gate criteria (items 1–5).
- relayer-v2 spec §7.3 (endpoint), §18 (F1–F6 dependency map, F5 row), §19.9 (endpoint built).
- Frontend: `apps/armada-interface/src/lib/railgun/{init,network,sync,prover,wallet}.ts`,
  `lib/events/*`, `hooks/useSpendableSyncGate.ts`, `state/wallet.ts`, `config/network.ts`.
- Node precedent: `lib/sdk/{init,network,wallet}.ts`.
- Contracts: `contracts/privacy-pool/storage/PrivacyPoolStorage.sol:145-149`;
  `contracts/privacy-pool/modules/MerkleModule.sol:157`; `.../TransactModule.sol:359-360`.
- SDK internals (node_modules): `@railgun-community/wallet/.../core/{init,engine}.js`;
  `@railgun-community/engine/dist/railgun-engine.d.ts:51`;
  `.../contracts/railgun-smart-wallet/V2/railgun-smart-wallet.js:74-83`.
- Relayer repo (external): `ship-armada/armada-relayer` → `relayer-v2/watcher/src/api/quick-sync.ts`,
  `.../api/index.ts`.
