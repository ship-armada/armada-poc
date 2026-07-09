<!-- ABOUTME: Implementation plan for the relayer side of the /relay idempotency key (T-M3/S-M1). -->
<!-- ABOUTME: Frontend half already shipped on iskay/interface-ux-robustness-spike; this is for a separate relayer agent session. -->

# Relayer `/relay` idempotency key — implementation plan

**Status:** Frontend half **DONE** (branch `iskay/interface-ux-robustness-spike`). This doc is the
**relayer-side** work, to be implemented in a separate agent session (touches `relayer/` → VPS
redeploy + restart).

## Background

The `armada-interface` now sends a client-generated **`idempotencyKey`** (the tx record's ulid) in
the `/relay` POST body. The key is **stable across retries/resume of the same tx** and **unique per
new tx**, so the relayer can deterministically recognise a re-POST.

Today the relayer dedups duplicate submits with an **in-memory** `txCache` in
`relayer/modules/wallet-manager.ts` — keyed on calldata, bounded by `DEDUP_TTL_MS` — and on a repeat
throws `RelayError("DUPLICATE_TX", ...)` whose message embeds the existing hash
(`"... already submitted as 0x<hash>"`). The frontend currently recovers by **parsing that hash out
of the 409 message** (`handleRelaySubmitError` / `extractDuplicateTxHash`).

That client-side recovery covers the common case but has gaps the idempotency key closes:
- **Not durable** — the cache is in-memory, so a relayer **restart** (every deploy) between the
  original broadcast and a client retry loses the dedup → the retry **re-broadcasts = double spend**.
- **TTL-bounded** — a retry after `DEDUP_TTL_MS` also re-broadcasts.
- **Fragile** — the client depends on a free-text message format.

## Goal

On a `/relay` POST carrying an `idempotencyKey`:
1. If the key was seen before → **return `200 { txHash, status }`** with the already-broadcast hash
   (NOT a 409, NOT a re-broadcast).
2. If not → submit as normal, then **persist `key → txHash`** durably before responding.
3. Concurrent POSTs with the same key must result in **exactly one broadcast** (in-flight lock).
4. Requests **without** a key fall back to today's calldata-dedup behaviour (backward compatible).

## Changes

### 1. Request type (`relayer/types.ts`)
Add `idempotencyKey?: string` to the `/relay` request type. Keep it optional for backward compat.

### 2. Durable idempotency store (new — `relayer/modules/idempotency-store.ts`)
A small persistent key→record store that survives restart. Shape:
```ts
{ idempotencyKey: string; txHash: string; chainId: number; status: 'pending'|'confirmed'|'failed'; createdAt: number }
```
- **Persistence:** simplest durable option that fits the single-process Node relayer — a JSON file
  flushed on write (or SQLite/`better-sqlite3` if a dependency is acceptable). Must survive process
  restart; the in-memory `txCache` is NOT sufficient.
- **TTL/cleanup:** evict entries older than e.g. 24h (well past the tx lifecycle) so the store
  doesn't grow unbounded. Sweep on startup + periodically.
- **In-flight lock:** a `Map<key, Promise<txHash>>` of submissions currently in progress so a second
  concurrent POST with the same key `await`s the first's result instead of broadcasting again.

### 3. `/relay` handler (`relayer/modules/http-api.ts`)
Before dispatching to `privacy-relay`:
```
const key = req.body.idempotencyKey
if (key) {
  const existing = idempotencyStore.get(key)       // durable lookup
  if (existing) return res.status(200).json({ txHash: existing.txHash, status: existing.status })
  const inflight = idempotencyStore.inflight(key)   // concurrent same-key
  if (inflight) return res.status(200).json({ txHash: await inflight, status: 'pending' })
}
// ... submit via privacy-relay ...
if (key) idempotencyStore.put(key, { txHash, chainId, status: 'pending' })
return res.status(200).json({ txHash, status: 'pending' })
```
Wrap the submit in the in-flight registration so step 3 above is race-safe.

### 4. Keep the calldata dedup as defence-in-depth
`wallet-manager.ts`'s existing `txCache` stays — it catches a duplicate even when no key is sent
(legacy clients) and guards against a key-store miss. The new key path is the **primary**,
restart-safe mechanism; the calldata cache is the fallback.

### 5. (Optional) status backfill
When `/status/:txHash` or the confirm path observes a terminal receipt, update the idempotency
store entry's `status` so a late repeat POST returns the accurate terminal status.

## Tests (`relayer/`)
- Repeat key → `200` with the **same** hash, **no second broadcast** (spy the wallet-manager submit).
- Two concurrent POSTs, same key → exactly **one** broadcast; both responses carry the same hash.
- **Restart persistence:** put a key, reload the store from disk, repeat POST → `200` same hash.
- Missing key → legacy calldata-dedup path unchanged.
- Store eviction past TTL.

## Frontend contract (already shipped — do not change)
- `RelayRequest.idempotencyKey` is sent by all 7 relayer-submit handlers (`= record.id`).
- The client treats any `200 { txHash, status }` as success (already does), so returning 200 on a
  repeat "just works" — no frontend change needed when this lands.
- `handleRelaySubmitError` + `extractDuplicateTxHash` (the 409-message fallback) stay as-is; once the
  relayer returns 200 on repeats they simply stop being exercised. Safe to keep indefinitely.

## Deployment
Relayer change → **pull + restart on the VPS** (and ensure the persistence file path is writable +
included in any volume/backup). Coordinate per the relayer deploy runbook.
