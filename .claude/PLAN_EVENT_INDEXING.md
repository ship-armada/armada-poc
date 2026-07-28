# PLAN: Event Indexing & Private Sync

**Status:** Partially superseded. The backend architecture (Phases 1–2 below) is **superseded by `specs/RELAYER_V2.md`** (watcher/actor split; single-scanner design) — do not implement the relayer delivered-feed or in-relayer/Ponder-sibling indexer as written here. The frontend phases (3–4), the privacy rules (§2), and the Phase-4 trust requirements (root validation, nullifier cross-check) remain valid and are referenced by the spec's §18 dependency map.
**Scope:** Replace per-user raw-RPC event fetching (shielded sync + cross-chain tx status) with relayer/indexer-served data, under hard privacy constraints.
**Related docs:** `PLAN_ARMADA_INTERFACE.md` (locked decision #27: `EventSource` seam; polling matrix row "Indexer health"), `RELAYER_MEDIATION_PLAN.md`, `apps/armada-interface/src/lib/events/CLAUDE.md`.

---

## 1. Problem & goal

Today every client independently re-derives global public data from raw RPC:

| Pain | Mechanism today | Cost |
|---|---|---|
| Cold shielded sync | Railgun SDK slow-scans hub from `deployBlock` → head via `eth_getLogs` (public RPC, `maxLogsPerBatch: 10`) | Hundreds–thousands of RPC calls per user per device; minutes of blocked spend UX (`useSpendableSyncGate`) |
| Incremental sync | SDK provider polling every 5s/15s per user | Continuous per-user RPC load |
| Cross-chain tx status | `scanCctpDeliveryWindow` — repeated ≤`maxLogRange`-block `MessageReceived` window scans on destination RPC, ~10s cadence per in-flight tx | Worst per-user RPC pattern; no dedup across in-flight txs |
| History | Local IndexedDB only | No cross-device history; lost on storage clear |

Commitments, nullifiers, unshields, and CCTP message lifecycles are identical public data for all users. Goal: serve them once from our infrastructure (relayer endpoint + Ponder indexer), with the frontend consuming via the existing `EventSource` seam, **without creating any new per-user observability**.

## 2. Privacy requirements (normative — every phase must satisfy these)

- **P1 — Global streams only.** Indexer/relayer read endpoints serve either (a) full event streams from a block/time cursor, byte-identical for every caller at the same cursor, or (b) lookups of inherently public chain data. No endpoint may accept a wallet address, npk, commitment hash, nullifier, or any shielded-domain identifier as a query parameter.
- **P2 — Client-side matching.** The frontend matches its own txs/notes locally (by source tx hash, nonce, or decryption). Never poll "status of MY tx X" against a read endpoint — fetch the recent-deliveries window and match in the client.
- **P3 — No identifiers.** No auth, cookies, sessions, or per-client tokens on read endpoints. Fee quotes stay global (`feesCacheId` is a global schedule id — must never become per-session).
- **P4 — Log & retention hygiene.** No IP retention on indexer/relayer read paths: app-level logs must not print request IPs; the VPS reverse proxy access log must be disabled or IP-anonymized (deployment checklist item, not just code). Relayer purges delivered pending-state metadata beyond the bounded delivered-feed window; long-term retained state is only what dedup requires (`sourceTxHash:logIndex` keys — public data).
- **P5 — History stays client-side.** "User X's history" is never materialized server-side; it is derived locally by decrypting the global stream.
- **P6 — Known residual leak (documented, not solved here).** `POST /relay` inherently ties submitter IP to a specific tx at submission time. Mitigation now: P4 hygiene. Structural fix (Waku-style broadcaster gossip / user-side Tor) is a separate post-POC track. Document in SECURITY.md.

Trust posture: the indexer is a **liveness/performance optimization, not a trust assumption** — the client validates ingested merkle roots on-chain and cross-checks its own notes' nullifiers against the contract (Phase 4, §7 items 3–4) and always retains an RPC fallback path. A malicious indexer can degrade liveness (forcing slow-scan fallback) but cannot forge balances or cause fund loss.

## 3. Target architecture

```
                          ┌─ VPS ─────────────────────────────────────────┐
Hub + Client RPCs ──────► │ armada-indexer (Ponder, sibling process)      │
   (getLogs, backfill)    │   indexes: Shield, Transact, Nullified,       │
                          │   Unshield, CrossChainShieldInitiated,        │
                          │   CrossChainUnshieldInitiated,                │
                          │   UnshieldReceived, MessageSent,              │
                          │   MessageReceived  (hub + 2 clients)          │
                          │   storage: PGlite (→ Postgres if needed)      │
                          │   HTTP: REST (EventSource + quick-sync        │
                          │   shapes) + /health                           │
                          │                                               │
                          │ armada-relayer (role unchanged)               │
                          │   + GET /cctp/delivered  (Phase 1)            │
                          └───────────────────────────────────────────────┘
                                   ▲ HTTPS — uniform global fetches
                              armada-interface
                               ├─ Phase 1: delivered-feed poll (replaces
                               │   destination-chain window scans)
                               ├─ Phase 3: IndexerEventSource (existing seam)
                               │   with RpcEventSource fallback
                               └─ Phase 4: quick-sync feed → SDK merkle tree
                                   + on-chain merkle root validation
```

Phases are independently shippable, in value-per-effort order. Phase 1 has no Ponder dependency.

---

## 4. Phase 1 — Relayer CCTP delivered feed (S, ~1–2 days)

Kills the worst per-user RPC pattern. The relayer already knows when each CCTP message lands (it broadcasts the destination tx and watches for the receipt) — it just doesn't expose or retain that knowledge.

### 4.1 Backend

**New: `relayer/lib/delivered-log-store.ts`** — bounded ring log of confirmed deliveries, one file per source chain (`relayer/state/delivered-<chain>.json`), built on the existing `JsonStateStore` primitive (atomic writes, schema-versioned).

```ts
interface DeliveredRecord {
  dedupKey: string;            // `${sourceTxHash}:${logIndex}` — same key as pending-state
  sourceDomain: number;
  destinationDomain: number;
  nonce: string;               // CCTP envelope nonce (hex)
  sourceTxHash: string;
  destinationTxHash: string;
  destinationBlock: number;
  deliveredAt: number;         // unix ms (relayer clock)
}
```

Retention: keep the most recent `DELIVERED_LOG_MAX` records per source chain (default 500) AND at least `DELIVERED_LOG_MIN_AGE_MS` (default 24h) — whichever retains more. All fields are public chain data (P4-compliant).

**Wire-up points:**
- `relayer/modules/iris-relay.ts` — in `processInflightRelays`, at the spot where a destination receipt confirms and the message moves to `processed`: append a `DeliveredRecord`.
- `relayer/modules/cctp-relay.ts` (mock mode) — same append where the mock relay confirms its destination tx, so local dev exercises the identical frontend path.

**New endpoint in `relayer/modules/http-api.ts`:**

```
GET /cctp/delivered?destinationDomain=N[&sinceMs=T][&limit=K]
→ 200 { records: DeliveredRecord[], generatedAt: number }
```

- `destinationDomain` required (validate against known domains; 400 otherwise). `sinceMs` filters `deliveredAt > T` (clients pass their last `generatedAt` as cursor). `limit` caps response (default/max 200).
- The query is chain-scoped + time-cursor only — identical for every user watching that corridor (P1). **Do not** add a `?sourceTxHash=` filter (P2).
- Extend `RelayerHealth`/counters with `deliveredFeed` size per chain. Update the `GET /` banner endpoint listing.

**Privacy/log hygiene in the same PR (P4):** audit `http-api.ts` logging — keep what exists for `/relay`, but the new endpoint logs nothing per-request (at most a counter). Add the reverse-proxy access-log requirement to the relayer deployment notes.

### 4.2 Frontend

**`src/config/relayer.ts`** — add `delivered: '/cctp/delivered'` to `RELAYER_ENDPOINTS`.

**`src/lib/relayer.ts`** — add typed client:

```ts
fetchDeliveredCctp(args: { destinationDomain: number; sinceMs?: number; signal?: AbortSignal })
  : Promise<{ records: DeliveredRecord[]; generatedAt: number }>
```

**`src/features/unshield-xchain/handler.ts` (and the shield-xchain equivalent)** — in the delivery-wait stage, restructure the poll tick as a two-tier check:

1. **Relayer feed (primary):** `fetchDeliveredCctp({ destinationDomain, sinceMs: cursor })`, match locally on `record.sourceTxHash === ourSourceTxHash` (we know our own source tx hash from the burn receipt — simpler and more robust than nonce/hookData matching). On match → `destinationTxHash`, advance stage.
2. **RPC window scan (fallback):** if the relayer fetch fails (network/5xx) or the relayer is unreachable per `useRelayerHealth`, fall through to the existing `scanCctpDeliveryWindow` tick unchanged. The `poll()` adapter shape (`pollOnce`) makes this a contained change; persist both the feed cursor (`sinceMs`) and the scan cursor (`nextScanFromBlock`) in `record.artifacts` so crash/resume works on either tier.

Keep all existing lifecycle/retry semantics (`lifecycles.ts` untouched except, if needed, artifact typing).

### 4.3 Tests

- **Relayer unit (mocha):** `delivered-log-store` retention/migration/atomicity; endpoint validation (bad domain, cursor filtering, limit cap); iris-relay + cctp-relay append-on-confirm (extend existing module tests).
- **Frontend unit (vitest):** `fetchDeliveredCctp` parsing/errors; handler tick — feed-match, feed-empty→no-match, feed-error→falls back to scan tier; cursor persistence/resume.
- **Integration/e2e (local):** `npm run chains` + `npm run setup` + relayer in mock mode → run an xchain unshield through the UI/handler; assert delivery detected via feed (telemetry/event assertion), then kill relayer mid-flight and assert scan-tier fallback completes.

### 4.4 Rollout

Touches `relayer/` → **flag for VPS pull + restart**. No schema/env changes; frontend change is backward-compatible (falls back if endpoint absent — treat 404 as feed-unavailable).

---

## 5. Phase 2 — `armada-indexer` (Ponder service) (M, ~3–5 days)

### 5.1 Placement & stack

- New workspace: `apps/armada-indexer/` (own `package.json`; add to root `workspaces`). Verify `npm install --legacy-peer-deps` tolerates Ponder's viem peer range before committing to the workspace approach — if it conflicts with the Railgun SDK pins, fall back to a standalone package with its own lockfile (precedent: `crowdfund-ui/packages/indexer` is already self-contained).
- Ponder (latest stable), PGlite storage by default (sufficient at current scale; Postgres is a config-only upgrade later).
- Runs as its own process: `ponder dev` locally, `ponder start` under the VPS process manager. Deliberately **not** embedded in the relayer — independent restart/failure domains, and Ponder owns its own reorg-safe store.

### 5.2 Config — generated from deployment manifests

`ponder.config.ts` must derive chains/addresses/start blocks from `deployments/*.json` (same source of truth as relayer + frontend), selected by `NETWORK=local|sepolia`:

- Chains: hub + clientA + clientB (RPC URLs from env, mirroring `config/networks.ts` values).
- Contracts + events:
  - **Hub PrivacyPool** (`startBlock` = manifest `deployBlock`): `Shield`, `Transact`, `Nullified`, `Unshield`, `CrossChainUnshieldInitiated`.
  - **Client PrivacyPoolClient** (per client manifest): `CrossChainShieldInitiated`, `UnshieldReceived`.
  - **MessageTransmitter** (all 3 chains): `MessageSent`, `MessageReceived`.
- ABIs imported from Hardhat artifacts (build step or checked-in ABI extracts — decide in implementation; prefer importing from `artifacts/` with a sync check so ABI drift fails loudly, cf. the crowdfund ABI-mismatch incident).

### 5.3 Schema (initial)

```
commitment_batch  (id = chainId:txHash:logIndex, kind: 'shield'|'transact', treeNumber,
                   startPosition, commitmentCount, blockNumber, txHash, logIndex,
                   rawData, rawTopics)       -- raw log preserved for EventSource Raw* shape
nullifier         (id = chainId:txHash:logIndex:i, treeNumber, hash, blockNumber, txHash, logIndex)
unshield          (id, to, tokenAddress, amount, fee, blockNumber, txHash)
cctp_message_sent (id, chainId, sourceDomain, destinationDomain, nonce, sourceTxHash, blockNumber)
cctp_message_received (id, chainId, sourceDomain, nonce, destinationTxHash, blockNumber)
xchain_initiated  (id, chainId, kind: 'shield'|'unshield', domain, amount, nonce, txHash, blockNumber)
```

Note: storing `rawData`/`rawTopics` for commitment/nullifier rows lets Phase 3 serve the frontend's `RawCommitment`/`RawNullifier` envelopes without decode/re-encode mismatch risk, and Phase 4 decode into engine types server-side. Revisit if row size becomes a concern (it won't at POC scale).

### 5.4 API (custom Hono routes in Ponder)

All P1-compliant — block-cursor streams only:

```
GET /v1/commitments?fromBlock=N[&toBlock=M][&limit=K]   → RawCommitment[] + nextCursor
GET /v1/nullifiers?fromBlock=N[...]                     → RawNullifier[] + nextCursor
GET /v1/logs?address=0x..&chainId=N&fromBlock=...       → RawTxLog[]    (EventSource.getTxHistory;
                                                          address = contract address, validated
                                                          against the known-contracts allowlist —
                                                          never user EOAs)
GET /v1/quick-sync/:chainId?startingBlock=N             → AccumulatedEvents (Phase 4 shape)
GET /health                                             → { status, perChain: { lagBlocks,
                                                            lastIndexedBlock, head } }
```

- Pagination: `limit` default/max 1000 rows, `nextCursor` block-based. Responses are cache-friendly (immutable for fully-indexed historical ranges → `Cache-Control: public, max-age=...` on closed ranges; short TTL near head). This is what later enables the CDN/static-snapshot option without API changes.
- CORS open; no auth (P3). No request-identifying logs (P4).

### 5.5 Local dev & deployment

- Root scripts: `npm run indexer` (local: `NETWORK=local ponder dev` against Anvil), `npm run indexer:sepolia`.
- Local note for docs: after `npm run setup` redeploys contracts, the indexer DB must be dropped (Ponder dev does this automatically on config change; document the manual reset anyway, same spirit as the `data/railgun-db/` pitfall).
- VPS: run under the same process manager as the relayer but as a separate unit; env from `config/sepolia.env` + secrets pattern. Reverse proxy: new hostname/path, **access logs disabled/anonymized (P4 checklist item)**.
- Frontend env: `VITE_INDEXER_URL` (Netlify env for hosted builds). Already plumbed in `config/network.ts` (`indexerUrl`, currently `null`).

### 5.6 Tests

- Unit: schema/indexing functions with Ponder's test harness (or thin pure decode helpers unit-tested directly); manifest→config derivation.
- Integration (local): full local stack, drive shield/transact/unshield/xchain flows via existing Hardhat test helpers, assert indexer rows + API responses match `eth_getLogs` ground truth (differential test — this is the load-bearing correctness check).
- e2e: frontend pointed at local indexer (Phase 3 consumes this).

---

## 6. Phase 3 — Frontend `IndexerEventSource` + finish `RpcEventSource` (S–M, ~2–3 days)

The seam already exists (`lib/events/` — factory selects by `cfg.indexerUrl`). This phase makes both implementations real.

### 6.1 `IndexerEventSource`

- Implement `getCommitments` / `getNullifiers` / `getTxHistory` against the Phase 2 REST shapes, with cursor-based pagination loops honoring `FetchRange` + `AbortSignal`.
- Strict response validation (zod or hand-rolled narrowing per app convention — TS strict, no `any`).

### 6.2 `RpcEventSource` (fallback tier — currently returns `[]`)

- Implement via the existing `getLogsChunked` + `NetworkConfig.maxLogRange`, topic filters per the event catalogue (Shield/Transact topics for commitments, Nullified for nullifiers). Bounded queries are non-negotiable per `lib/events/CLAUDE.md`.

### 6.3 Fallback policy

- Add a `FallbackEventSource` decorator (indexer-first, per-call fallback to RPC on error/timeout) rather than baking fallback into either implementation — matches the CLAUDE.md note that caching/decoration belongs in a wrapper. Factory composes: indexer configured → `Fallback(Indexer, Rpc)`; else `Rpc`.
- Indexer health: add the planned 60s react-query poll against indexer `/health` (polling matrix row already reserved); surface degradation in the existing status-banner pattern. Indexer down must never hard-block the app (P-trust posture: liveness optimization only).

### 6.4 Consumers

- First consumer: the Phase 1 delivery-wait tick can optionally read `MessageReceived` via `getTxHistory` from the indexer when the relayer feed is unavailable (third tier), but keep this minimal — relayer feed remains primary for delivery status.
- History-page enrichment (global stream + local decryption only, P5) is a follow-up feature pass, not part of this phase.

### 6.5 Tests

Unit: both implementations (mock fetch / mock provider), decorator fallback semantics, abort propagation. Integration: against local Ponder from Phase 2. e2e: full local flow with `VITE_INDEXER_URL` set, then unset (RPC-only path), asserting identical UI outcomes.

---

## 7. Phase 4 — Quick-sync injection + merkle root validation (M–L, decision-gated)

**Goal:** cold shielded sync = one HTTP fetch of `AccumulatedEvents` + on-chain root check, instead of an O(chain-length) slow scan.

**Decision gate (resolve before starting):** the wallet SDK's `startRailgunEngine()` (used by `apps/armada-interface/src/lib/railgun/init.ts`) does **not** expose a quick-sync override. The engine-level `RailgunEngine.initForWallet()` does (5th param `quickSyncEvents: (txidVersion, chain, startingBlock) => Promise<AccumulatedEvents>`), and the repo already uses this pattern in `lib/sdk/init.ts`. Porting the frontend from the wallet SDK to engine-level init means re-providing the wallet-SDK conveniences the app currently uses (`loadProvider`, `setOnUTXOMerkletreeScanCallback`, `setOnBalanceUpdateCallback`, `balanceForERC20Token`, `refreshBalances`, wallet creation) with engine-level equivalents — `lib/sdk/` is the in-repo precedent, but it's real work and touches the security-sensitive wallet path. **Alternatives to weigh at the gate:** (a) do the engine-level port (full quick-sync win); (b) defer — with `deployBlock` bounding and IndexedDB persistence, cold scan is once-per-device and may be tolerable until event volume grows; (c) investigate whether a newer wallet-SDK release exposes an override (re-check at implementation time). Default recommendation: (a) once Phases 1–3 are stable, sized as its own PR series.

**Work items (if gate passes):**
1. **Engine-level init port** in `lib/railgun/init.ts` — `RailgunEngine.initForWallet(...)` with: artifact getter (reuse existing IndexedDB store), `quickSyncEvents` → `GET /v1/quick-sync/:chainId?startingBlock=N` via `IndexerEventSource`-adjacent client, falling back to empty `AccumulatedEvents` (= slow scan) on any failure.
2. **Server-side decode** (Phase 2 indexer): add the quick-sync route decoding stored raw logs into the engine's exact `CommitmentEvent`/`UnshieldStoredEvent`/`Nullifier` types. Pin the types with a compile-time check against `@railgun-community/engine` exports so SDK upgrades fail the build, not the runtime.
3. **Merkle root validation (hard prerequisite, do not ship quick-sync without it):** implement the `MerklerootValidator` callback to verify ingested roots against the hub PrivacyPool's on-chain root history (`rootHistory`/equivalent getter on the Commitments logic), via the app's hub provider — i.e., the chain remains the root of trust; a malicious indexer can only cause sync failure, never balance forgery. Replace the current local-dev `return true` posture for sepolia/production builds.
4. **Nullifier cross-check (closes the one gap root validation can't):** nullifiers are not part of the commitment merkle tree, so an indexer that serves commitments faithfully but omits a `Nullified` event passes root validation while making an already-spent note appear unspent — an inflated *displayed* balance (never spendable; the chain rejects the double-spend). Mitigation: before spend-readiness gating (`useSpendableSyncGate`), cross-check the user's own unspent notes' nullifiers against the pool contract's on-chain nullifier mapping via `eth_call` on the hub RPC (small set, cheap; goes to the RPC, never the indexer — P1/P2 preserved). Privacy wrinkle to resolve in implementation: pre-querying one's own nullifier lets the RPC provider link it to the caller's IP when it is later spent on-chain. Options: batch the checks via multicall together with decoy nullifiers sampled from the global stream, or accept the leak (it is to the RPC provider, matching today's exposure surface). Decide and document at implementation time.
5. **Snapshot/CDN option (stretch):** publish periodic immutable `AccumulatedEvents` snapshot files (the closed-range cacheability from §5.4 makes this near-free) so end-user IPs never reach our origin for sync. Evaluate after measuring real fetch sizes.

**Tests:** unit — quick-sync client (success/fallback), root-validation accept/reject, nullifier cross-check (spent note flagged, unspent note passes); integration — differential sync: fresh client synced via quick-sync vs. via slow scan must produce identical merkle roots and balances on local stack; adversarial — (a) corrupted indexer response (mutated commitment) must fail root validation and fall back without poisoning the IndexedDB tree; (b) nullifier-omission response (valid commitments, one `Nullified` event dropped) must pass root validation but be caught by the nullifier cross-check before the spend gate opens — this case is explicitly not catchable by root validation, so the cross-check test is the only line of defense.

---

## 8. Cross-cutting

### 8.1 Testing summary (per repo policy: unit + integration + e2e every phase)

| Phase | Unit | Integration | e2e |
|---|---|---|---|
| 1 | store, endpoint, handler tick (mocha + vitest) | local stack xchain flow via feed | UI flow + relayer-kill fallback |
| 2 | indexing fns, config derivation | indexer rows vs `eth_getLogs` differential | consumed by Phase 3 e2e |
| 3 | both EventSources + fallback decorator | against local Ponder | indexer-on vs indexer-off parity |
| 4 | quick-sync client, root validator | quick-sync vs slow-scan differential | cold-unlock UX on local + sepolia |

### 8.2 Deployment / ops checklist

- [ ] Phase 1 relayer deploy: VPS pull + restart (flag in PR per standing practice).
- [ ] Reverse-proxy access logs disabled/anonymized for relayer read endpoints + indexer (P4) — verify, don't assume.
- [ ] Indexer systemd/pm2 unit, separate from relayer; `relayer/state/`-style dir conventions for PGlite data; gitignore check for new state/data dirs.
- [ ] `VITE_INDEXER_URL` in Netlify env (sepolia builds); absent locally unless testing indexer path.
- [ ] Docs: root CLAUDE.md (new workspace + scripts + pitfall entries), relayer CLAUDE.md (new endpoint), `lib/events/CLAUDE.md` status table, SECURITY.md (P6 residual leak).

### 8.3 Open questions

1. Ponder ↔ `--legacy-peer-deps` workspace compatibility (resolve at Phase 2 start; fallback: standalone lockfile).
2. ABI sourcing for Ponder: import from Hardhat `artifacts/` at build vs. checked-in extracts with a drift check.
3. Phase 4 gate: engine-level port now vs. defer (see §7).
4. Mock-mode `cctp-relay.ts` delivered-feed parity — confirm the mock relay has an equivalent "delivery confirmed" point with a destination tx hash (expected yes; verify during Phase 1).
5. Whether the relayer's `/cctp/delivered` eventually retires in favor of the indexer's `MessageReceived` stream, or both persist (relayer feed is authoritative for relayer-delivered messages and has lower latency; default: keep both, frontend prefers relayer feed).
