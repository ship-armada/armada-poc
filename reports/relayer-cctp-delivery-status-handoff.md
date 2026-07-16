<!-- ABOUTME: Handoff for the relayer-side /cctp-status endpoint (T-M7 Option B cross-chain delivery correlation). -->
<!-- ABOUTME: Frontend half already shipped on iskay/interface-ux-robustness-spike; this is for a separate relayer agent session. -->

# Relayer `/cctp-status/:messageHash` endpoint — handoff

**Status:** Frontend half **DONE** (branch `iskay/interface-ux-robustness-spike`). This is the
**relayer-side** work, for a separate agent session (touches `relayer/` → VPS redeploy + restart).

**Read alongside:** `reports/iris-nonce-correlation-plan.md` (the design rationale: why correlate
delivery via the relayer instead of content-sniffing destination logs).

---

## What the frontend already does (the contract you must satisfy)

The `armada-interface` cross-chain delivery stage now polls **the relayer first** and falls back to
its on-chain log scan only when the relayer endpoint is unavailable. See:
- `src/lib/relayer.ts` → `fetchCctpDeliveryStatus(messageHash, signal)` + `CctpDeliveryStatus`.
- `src/config/relayer.ts` → `RELAYER_ENDPOINTS.cctpStatus = '/cctp-status'`.
- Both `features/unshield-xchain/handler.ts` and `features/shield-xchain/handler.ts` →
  `runWaitForDelivery` poll loop (relayer-first, scan-fallback).

### Request
```
GET /cctp-status/:messageHash
```
`messageHash` = `keccak256(messageBytes)` of the **source** CCTP message — exactly the value the
relayer already uses as its Iris attestation lookup key (`relayer/modules/iris-relay.ts`,
`messageHash`). The frontend captures it at burn time (`lib/cctp.ts::extractCctpMessageFromReceipt`
→ stored in the record's `artifacts.messageHash`) and sends it verbatim.

### Response (200) — JSON body the frontend parses
```ts
{
  status: 'pending' | 'delivered' | 'failed',
  destTxHash?: string,   // REQUIRED when status === 'delivered' (the destination mint tx hash)
  amount?: string,       // optional — delivered amount (raw USDC), for future maxFee-tolerance verify
  feeExecuted?: string,  // optional — Iris fee taken on the destination
  error?: string,        // optional — human reason when status === 'failed'
}
```
Exact frontend mapping (`fetchCctpDeliveryStatus`):
- `status: 'delivered'` **with** a string `destTxHash` → the stage completes on that hash.
- `status: 'delivered'` **without** `destTxHash` → treated as malformed → `unavailable` → frontend
  falls back to the scan. **So always include `destTxHash` on delivered.**
- `status: 'pending'` → keep polling.
- `status: 'failed'` → the stage fails the tx (`TX_REVERTED`, surfaces `error`).
- Any other / missing `status` → `unavailable` → scan fallback.

### Status codes
- **200** → parsed as above.
- **404** → frontend treats as `unavailable` (endpoint not deployed) → **scan fallback**. This is
  why the rollout is safe to ship frontend-first: until the route exists, every poll 404s and the
  existing on-chain scan runs exactly as before.
- **any non-2xx (5xx, etc.)** → `unavailable` → scan fallback (relayer degraded ≠ tx failed).
- The frontend polls every ~3s (the delivery poll interval) with a 10s per-request timeout; a
  network error / timeout also degrades to `unavailable` → scan fallback.

---

## What to build (relayer)

The relayer **already performs the destination mint in both modes** and knows when it lands:
- **mock mode** (`relayer/modules/cctp-relay.ts`) — polls source burns, calls
  `CCTPHookRouter.relayWithHook()` on the destination.
- **real mode** (`relayer/modules/iris-relay.ts`) — polls Circle's Iris for attestation, then calls
  `receiveMessage(message, attestation)` on the destination.

Both already track in-flight messages keyed by `messageHash`. The endpoint exposes that state.

### 1. Delivery index keyed by `messageHash`
Maintain `messageHash → { status, destTxHash?, amount?, feeExecuted?, error?, updatedAt }`:
- `pending` once the source burn is observed / the message is in flight.
- `delivered` + `destTxHash` when the destination `relayWithHook` / `receiveMessage` tx confirms.
  Populate `amount` + `feeExecuted` from the CCTP message / receipt if cheap to extract.
- `failed` + `error` if the destination mint reverts.
- Ideally **durable** (survive restart) like the idempotency store — but even an in-memory index is
  a net improvement since the frontend falls back to the scan on a miss/404.
- TTL/evict past the xchain lifecycle cap (≥ 60 min + margin).

### 2. `GET /cctp-status/:messageHash` (`relayer/modules/http-api.ts`)
- Look up the index. Hit → `200` with the record. Miss → **404** (frontend falls back to the scan;
  do NOT 500 on an unknown hash).
- Read-only; no auth beyond what the other GET endpoints use.

### 3. Wire both relay modules to write the index
- `cctp-relay.ts`: on a successful `relayWithHook`, write `delivered` + the destination tx hash.
- `iris-relay.ts`: on a successful `receiveMessage`, write `delivered` + the destination tx hash;
  keep `pending` while awaiting attestation; `failed` on a reverted mint.

### 4. Tests (`relayer/`)
- Known delivered hash → `200 { status:'delivered', destTxHash }`.
- In-flight hash → `200 { status:'pending' }`.
- Unknown hash → `404`.
- Mint revert → `200 { status:'failed', error }`.
- (If durable) survives a restart.

---

## Why this is safe to ship frontend-first
Every poll currently 404s → the frontend runs its existing on-chain destination scan, i.e. **no
behavior change until your endpoint is live.** Once deployed, the relayer becomes the authoritative,
both-modes delivery signal (precise `destTxHash`, disambiguates identical parallel burns by message
hash, and — once `amount`/`feeExecuted` are populated — lets the frontend drop the fragile
BurnMessage byte-offset amount parsing the audit flagged). No frontend change needed when it lands.

## Deployment
Relayer change → **pull + restart on the VPS**. If you make the delivery index durable, ensure the
persistence path is writable + backed up (same consideration as the idempotency-key store).
