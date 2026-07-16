<!-- ABOUTME: Plan for the full T-M7 fix — Iris-nonce delivery correlation for cross-chain shield/unshield. -->
<!-- ABOUTME: The quick part (source-domain match) already shipped; this is the deferred, real-CCTP-mode subsystem. -->

# Cross-chain delivery correlation via Iris (full T-M7) — plan

**Status:** PLAN ONLY. The **quick part shipped** (`72eca15`) — `matchesXchainDelivery` now requires
the CCTP source domain to be the hub's, on top of the recipient marker. This doc is the **full**
correlation, deferred during the audit as a real-CCTP-mode subsystem.

## Where we are

Cross-chain delivery detection (`unshield-xchain` to a client chain; `shield-xchain` to the hub)
**scans the destination chain's `MessageReceived` logs** and matches by:
- the recipient marker in the hookData (`pad32(recipient)` for unshield-xchain; `encryptedBundle[0]`
  for shield-xchain), **and**
- the CCTP **source domain** (now), and
- a `destFromBlock` cursor snapshotted at burn time.

We **already capture**, at burn time, into the record's artifacts (`features/*/handler.ts` →
`lib/cctp.ts::extractCctpMessageFromReceipt`):
- `messageHash` = `keccak256(messageBytes)` — Iris's attestation lookup key, **and**
- `cctpNonce` — the source nonce, **and** `sourceTxHash`.

## The residual gap

Content-sniffing destination logs cannot disambiguate **two parallel, identical burns**
(same amount + recipient + source) — they produce the **same `messageHash`** (CCTP V2 zeroes the
outbound nonce slot; Iris assigns the real `eventNonce` on the destination, not derivable
source-side). The burn **amount isn't verified** either — the quick fix deliberately skipped it
because the amount lives at a byte offset in the CCTP `BurnMessage`, and a wrong offset would
**silently break delivery detection** (funds-appear-stuck). And **mock mode** (local `cctp-relay`)
vs **real mode** (`iris-relay` + Circle's Iris) behave differently.

## The full fix: correlate by the source burn, via Iris

Circle's Iris API can be queried **by the source burn transaction hash** (which IS unique per burn,
unlike `messageHash`). It returns the canonical message + attestation status + the assigned
`eventNonce`. That lets us correlate the **exact** delivery — disambiguating identical parallel
burns by their distinct source tx hashes — and yields the **authoritative burn amount +
`feeExecuted`** for free (no fragile byte-offset parsing).

- Iris endpoints (already used by `relayer/modules/iris-relay.ts`):
  - Testnet: `https://iris-api-sandbox.circle.com`
  - Mainnet: `https://iris-api.circle.com`
- Lookup by source tx hash returns per-message `{ status, attestation, eventNonce, ... }`.

### Architecture — two options

**Option A — frontend polls Iris directly.** (The old `useCctpAttestation` stub was removed in
T-L9; Option A would re-create a hook.) Poll Iris by `sourceTxHash`/`messageHash`, gate on
`tabVisibleAtom` + the lifecycle budget, and feed the delivery stage. Then match the destination
`MessageReceived` by the Iris-assigned `eventNonce` (precise) instead of recipient content.
- Pros: no relayer dependency for real mode.
- Cons: **doesn't help mock mode** (local `cctp-relay`, no Iris); possible CORS/rate-limit/latency
  handling on the client; duplicates the Iris integration the relayer already has.

**Option B (recommended) — relayer reports delivery status; frontend polls the relayer.** The
relayer already performs the destination mint in BOTH modes (`cctp-relay` mock + `iris-relay` real)
and already polls Iris for attestations. Expose a delivery-status endpoint keyed by `messageHash` /
source tx hash (e.g. `GET /cctp-status/:messageHash` → `{ status: 'pending'|'delivered'|'failed',
destTxHash?, amount?, feeExecuted? }`). The frontend's delivery stage polls THAT (reuse
`useCctpAttestation` or `pollRelayStatusOnce`-style adapter).
- Pros: **single source of truth for both modes**; reuses the relayer's Iris + dedup; gives the
  authoritative `destTxHash` + amount; no client-side Iris/CORS concerns.
- Cons: a relayer change (→ VPS redeploy), and a relayer outage blocks delivery confirmation (today
  the on-chain scan is self-sufficient — keep it as fallback).

### Recommended shape
1. **Relayer:** add the delivery-status endpoint (Option B), keyed by `messageHash` (we already
   store it). Real mode reads its Iris poll results; mock mode reads its `cctp-relay` mint results.
   Handoff: `reports/relayer-cctp-delivery-status-handoff.md`.
2. **Frontend — ALREADY SHIPPED (`3470a3eb`).** The delivery stage polls the relayer endpoint
   (`lib/relayer.ts::fetchCctpDeliveryStatus`) as the **primary** signal; the destination-log scan
   (`scanCctpDeliveryWindow` + `matchesXchainDelivery`) stays as the **fallback** when the relayer
   is unavailable. Once the relayer returns `amount`/`feeExecuted`, the frontend can additionally
   verify within `maxFee` tolerance (dropping the fragile BurnMessage byte-parsing).
3. `useCctpAttestation` was **removed** in T-L9 (Option B uses `fetchCctpDeliveryStatus`, not a
   client Iris hook). Only Option A would need to re-create a hook.

## Tests
- Iris/relayer status mock: pending → delivered transitions drive the stage to terminal with the
  reported `destTxHash`.
- Two identical parallel burns (same amount/recipient/source, different `sourceTxHash`) resolve to
  their **own** deliveries — the core disambiguation the log-scan can't do.
- Amount mismatch (delivered ≠ burn − feeExecuted within tolerance) → does NOT false-complete.
- Relayer-unreachable → falls back to the on-chain scan (current behaviour preserved).

## Effort / risk
High — new relayer endpoint + real-mode Iris wiring + frontend polling + real-mode testing on
Sepolia. Tied to the relayer's `iris-relay` module. Not mainnet-blocking but required for robust
real-CCTP delivery tracking at scale. Touches `relayer/` → VPS redeploy.

## Related
- Quick part shipped: `72eca15` (`matchesXchainDelivery` source-domain match).
- `lib/cctp.ts` already exposes `findMessageReceivedByNonce` — useful once we have the Iris
  `eventNonce`.
