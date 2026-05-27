# Relayer-Mediated Submission & Gasless UX — Plan

Captures the analysis + decision for moving from "every tx self-submitted by the user's wallet" toward "user pays in USDC, relayer pays gas, no native token required to transact." Three problems considered together because they're tightly coupled:

1. Actual relayer submission (instead of every handler calling `sendTransaction` via the user's wallet)
2. Fee quote + USDC reimbursement up front (so the relayer isn't just fronting gas)
3. Gasless UX — user holds USDC only; relayer pays ETH, takes USDC reimbursement

Sizing: XS (<1 hr), S (<½ day), M (~1 day), L (multi-day).

---

## What's already wired

The scaffolding is more complete than the current "everything submits via the user wallet" behaviour suggests.

### Relayer

- **`POST /relay`** (`relayer/modules/privacy-relay.ts`) — accepts `{chainId, to, data, feesCacheId}`, validates target is in the allowed-contracts set, validates the function selector is in the allow-list (`transact`, `atomicCrossChainUnshield`, `lendAndShield`, `redeemAndShield`), runs `eth_estimateGas` to catch reverts, submits via the relayer wallet, returns the tx hash. Already works end-to-end; nothing calls it from the frontend yet.
- **`GET /fees`** (`relayer/modules/fee-calculator.ts`) — returns a `FeeSchedule` with per-operation USDC fees computed as `gasEstimate × gasPrice × ethUsdcPrice × (1 + profitMarginBps)`. Cached with a 5-minute TTL. The schedule's `cacheId` is what `/relay` expects clients to echo back via `feesCacheId`.
- **`GET /status/:txHash`** — checks receipt status.
- **`GET /health`** — per-chain scanner state (shipped in PR #295).
- **Relayer wallet** (`relayer/modules/wallet-manager.ts`) — single deployer EOA, dedup cache on `keccak256(to, data)`, fresh-nonce-per-tx (shares the account with the CCTP relay, so caching breaks).

### Frontend

- **`lib/relayer.ts`** — typed `fetchFees` works; `submitRelay` is a thrown stub with a comment that says "relayer-mediated submit is a future commit."
- **`hooks/useFees.ts`** — React Query polling, atom mirror, exponential cold-start backoff. Live.
- **`config/relayer.ts`** — endpoint constants + error code mapping. Live.
- **Stage handler scaffold** — all 7 handlers (`shield`, `unshield`, `transfer-shielded`, `yield-deposit`, `yield-withdraw`, `shield-xchain`, `unshield-xchain`) call `populateProvedX()` from the Railgun SDK and submit via `sendTransaction(wagmiConfig, ...)` against the user's wallet. Each one passes `sendWithPublicWallet: true` and `broadcasterFeeRecipient: undefined` to the SDK — the explicit "self-submit, no broadcaster fee" branch.
- **Modal fee plumbing** — `feeCacheId` is captured at submit time and threaded through `TxRecord.meta` for every kind. Today nothing consumes it; reserved so the relayer-submit path doesn't require a second meta-shape refactor.

### Contracts

- `PrivacyPool.shield()` pulls USDC via `transferFrom(msg.sender, pool, value)` — msg.sender doesn't have to be the user, as long as it has USDC (or allowance). Key insight for the wrapper-based gasless shield design.
- `PrivacyPool.transact()` natively supports broadcaster fees via an additional unshield output baked into the Transaction struct — paid as a shielded UTXO to the relayer's `0zk` address. Already in the contract; no contract changes needed for non-shield gasless.
- No wrapper contract exists today.

---

## Decision: Option 1 for testnet, EIP-7702 as the strategic direction

After comparing three architectures (see "Considered alternatives" below):

- **Short term (this POC / testnet)**: hybrid — native Railgun broadcaster fee for ops where the proof can carry it; a thin `GaslessShieldWrapper` for the ops where it can't.
- **Long term (post-POC)**: investigate EIP-7702 account abstraction as the unifying path. Documented direction, not scheduled.

### Why Option 1

- Smallest delta from where we are. Native broadcaster fee is a built-in Railgun primitive (`sendWithPublicWallet: false` + `broadcasterFeeRecipient`); just flip the flag for 5 of 7 kinds and parse-verify the fee server-side.
- The wrapper for shield is a small, contained contract (~80 lines + permit). Audit surface is bounded.
- No new infrastructure dependency (no bundler, no paymaster).
- Compatible with every wallet today (MetaMask, WalletConnect, RainbowKit), no SCW migration, no two-address surface.
- Estimated total effort: ~5-6 days end to end.

### Why not EIP-7702 now

- Right answer in ~12 months when ecosystem support hardens. Adds bundler infra dependency, paymaster relationship, and SCW-vs-EOA reasoning complexity that doesn't pay off until AA features beyond gasless (batched ops, session keys, social recovery) become product requirements.
- Railgun SDK was designed for EOA signing; AA integration is a research-grade lift today.
- See `## Considered alternatives` below for the full comparison.

---

## What needs to be built (Option 1)

### Phase A — Native broadcaster fee for non-shield ops

The 5 kinds that have a proof and can carry the relayer payment inside it: `unshield-local`, `unshield-xchain`, `transfer-shielded`, `yield-deposit`, `yield-withdraw`.

| Item | Where | Size | Notes |
|---|---|---|---|
| Expose relayer's `0zk` address from `/fees` | `relayer/modules/fee-calculator.ts` + `lib/relayer.ts` | S | Frontend needs the `broadcasterFeeRecipient` to bake into proofs. Already produced by `scripts/derive_relayer_railgun_address.ts`; surface it in the fee schedule response. |
| Flip `sendWithPublicWallet: true → false` + pass `broadcasterFeeRecipient` + `overallBatchMinGasPrice` | `lib/railgun/{unshield,transfer,yield}.ts` | M | Per-kind. Each call site already has the params as `undefined`; switch to real values from the fee quote. `overallBatchMinGasPrice` commits the relayer to a max gas price as anti-griefing. |
| Replace `sendTransaction(wagmiConfig, ...)` with `submitRelay({...})` | `features/{unshield,transfer-shielded,yield-deposit,yield-withdraw}/handler.ts` + `features/unshield-xchain/handler.ts` (hub-burn step only) | M | Same shape as today — populate calldata, post to relayer. Receipt waiting changes from `waitForReceiptOrFail({hash})` to `pollStatus(txHash)` against the relayer. |
| Server-side broadcaster fee verification | `relayer/modules/privacy-relay.ts` | M | Before submitting, parse the Transaction struct's `commitmentCiphertext` array, find the output to the relayer's `0zk` address, decode the encrypted amount, verify `amount >= advertisedFee`. Without this, a malicious user can submit a $0-fee proof and the relayer pays gas for nothing. **Security-critical.** |
| Wire `submitRelay` (frontend) — implement the throwing stub | `lib/relayer.ts` | S | Already typed. Just remove the throw, do the fetch. |
| Status polling | `lib/tx/poller.ts` adapter + `useTx` integration | S | New `pollRelayStatusOnce(txHash)` adapter mirrors the existing `pollIrisOnce` pattern. |
| Telemetry events | `lib/telemetry.ts` event registry | XS | `tx.relayer.submitted`, `tx.relayer.confirmed`, `tx.relayer.rejected` keys. |
| Modal fee display — show "relayer fee" line | `components/ui/FeeSummary.tsx` | XS | Replaces today's `userFeeForKind` returning `0n` for non-xchain kinds. The relayer fee from the quote becomes the displayed USDC cost. |
| Cancel UX | `lib/tx/executor.ts` cancel path | S | Today's `cancelTx` aborts the pre-broadcast handler chain. Once we POST to relayer, the call is in flight server-side; cancel becomes "dismissed" (mark as DISMISSED with the request id; the relayer may still submit). |
| Dual-mode toggle (handler chooses self-submit vs relayer-submit) | per-handler entry point | S | Default to relayer-submit when the user has no native token. Explicit "submit from wallet" override for users who want it. Phase A can hardcode relayer-submit and skip the toggle. |
| Tests + Sepolia validation | various | M | New unit tests for fee verification in privacy-relay; manual Sepolia flows for each kind. |

**Phase A total: ~2.5 days**, scoped per-kind so it can land in 2-3 PRs (e.g. shield-side scan helpers first, then handler swaps, then fee verification + cancel UX polish).

### Phase B — Wrapper-based gasless for shield ops

The 2 kinds where the proof can't carry the relayer payment (no nullifier exists to fund the broadcaster output): `shield`, `shield-xchain`.

| Item | Where | Size | Notes |
|---|---|---|---|
| `GaslessShieldWrapper` contract (hub) | `contracts/GaslessShieldWrapper.sol` (new) | M | ~80 lines. `gaslessShield(permitSig, shieldRequest, fee)`: `usdc.permit(...)` → `transferFrom(user, relayer, fee)` → `transferFrom(user, wrapper, amount - fee)` → `usdc.approve(pool, ...)` → `pool.shield([request], integrator)`. `onlyRelayer` gates the entry point so front-runners can't steal a leaked permit. |
| `GaslessShieldWrapperClient` (per client chain) | `contracts/GaslessShieldWrapperClient.sol` (new) | M | Symmetric — calls `PrivacyPoolClient.crossChainShield(...)`. |
| MockUSDC permit support | `contracts/mocks/MockUSDC.sol` | XS | Switch base from `ERC20` to OZ's `ERC20Permit`. Real Sepolia USDC already implements permit (EIP-2612). Mainnet USDC v2.2+ does too. Zero behaviour change for non-permit callers. |
| Deploy + register the wrappers | `scripts/deploy_gasless_wrapper.ts` (new) + `scripts/setup_chains.sh` integration | S | One-shot deploy; the wrapper address goes into the deployment manifest for the frontend to read. |
| Permit signing flow | `lib/wallet/permit.ts` (new) + shield handlers | M | viem has `signTypedData` for EIP-2612 baked in. The shield handler captures both the SHIELD_SIGNATURE_MESSAGE (existing) and a permit signature (new), bundles both into the relayer POST. |
| Relayer endpoint — new selector + verification | `relayer/modules/privacy-relay.ts` | S | Add the wrapper's `gaslessShield` selector to the allow-list. Verify the wrapper address matches the deployed one. Verify the `fee` argument matches the advertised quote. |
| Tests + Sepolia validation | various | M | Unit tests for the wrapper (permit replay, deadline, allowance race, front-run gate). Manual Sepolia shield + xchain shield flows. |

**Phase B total: ~3 days**, on top of Phase A.

### Overall Option 1 sequencing

1. **Phase A** lands first — covers the 5 high-volume kinds, exercises the relayer-submit path, hardens fee verification before the wrapper introduces a second path to verify.
2. **Phase B** lands second — closes the gasless gap for the first-time-user "I just have USDC" case.

Between A and B, the app is in a hybrid state: gasless for unshield/transfer/yield (the bulk of repeat-user actions), still requires gas for first-time shield. That's a reasonable shipping milestone.

---

## Considered alternatives

### Option 2 — "Wrapper as recipient" for both shield AND unshield

Make the wrapper a universal entry point that skims a fee at the USDC boundary:
- Shield path: permit → wrapper pulls USDC, takes fee, calls `shield()`
- Unshield path: proof says "recipient = wrapper" → wrapper splits USDC and forwards user-portion onward

Unifies 4 of 7 kinds (shield, unshield, shield-xchain, unshield-xchain) under one wrapper. **But**: transfer-shielded, yield-deposit, yield-withdraw never surface USDC — they're shielded→shielded — so the wrapper has nothing to skim. Those MUST use native broadcaster fee anyway.

Net: still two patterns, just split differently (USDC-surfacing vs not, instead of has-proof-payment vs not). Same effort. The wrapper grows (handles 4 kinds, more code per surface), unshield loses the elegant proof-based payment guarantee (the wrapper becomes a trust dependency we can't audit out of), and the contract surface widens for marginal benefit.

**Rejected**: doesn't actually reduce the number of patterns; trades one asymmetry for another.

### Option 3 — EIP-4337 / EIP-7702 account abstraction

Long-term direction. Every user has either a smart-contract wallet (4337) or an EOA with delegation (7702); a paymaster sponsors gas in USDC; a bundler submits UserOps.

**EIP-4337 + MetaMask**: works, but the user's on-chain wallet becomes an SCW address distinct from their MetaMask EOA. Two-address surface for any wallet-app where address identity matters. Modern AA apps (Privy, Dynamic, ZeroDev) hide this by treating "your wallet" as the SCW from day one, which only works for AA-native dapps. Users who arrive via "connect MetaMask, here's my USDC" feel the hop.

**EIP-7702 + MetaMask** (Pectra, mainnet ~May 2025): EOA temporarily delegates execution to a smart-contract implementation. The user's address stays the same. MetaMask v12+ supports signing 7702 authorizations natively. viem + wagmi support is fresh but real. This IS the right answer for "AA benefits without migrating addresses" — but ecosystem support is still maturing (mid-2026), bundler vendors all have 7702 paths but the SDKs/docs aren't battle-tested, paymaster contracts need to be 7702-aware, and Railgun SDK integration is a research-grade lift (SDK was designed for EOA signing; pool reads `msg.sender` directly).

| | Option 1 (custom relayer + wrapper) | EIP-7702 + paymaster |
|---|---|---|
| MetaMask address preservation | ✅ | ✅ |
| User flows in 2026 | one familiar wallet | familiar wallet + new "smart account" prompt per tx |
| Contract surface | 1 wrapper + relayer-aware fee logic | Paymaster + delegation logic + bundler dependency |
| Bundler infra | None — relayer IS the submission path | Required (Pimlico/Stackup/Alchemy/self-host) |
| Unification across ops | Two patterns (wrapper vs proof) | One pattern for everything |
| Time-to-ship | ~5-6 days | ~3-4 weeks |
| Future-proof | Will need a parallel AA path eventually | Already on the standard rail |

**Rejected for now, kept as documented strategic direction**: 7702 is the right answer when AA-style features become a competitive necessity (batched ops, session keys, social recovery) — not just gasless. For the immediate question "users transact without ETH today", the custom path ships faster and adds less infrastructure weight. The relayer abstraction in Option 1 should be designed so swapping in a bundler-backed implementation later is a back-end change, not a frontend rewrite.

---

## Risks worth flagging

### Phase A

- **Fee verification is security-critical.** Without it, a malicious client submits a proof with a zero-value broadcaster output and the relayer eats gas. The verification has to parse the Transaction struct's encrypted commitment ciphertext array, find the output addressed to the relayer's `0zk`, decode the value, and bounds-check it against the advertised fee. There IS prior art in the Railgun ecosystem (broadcaster nodes do this); we'd want to mirror their approach rather than invent.
- **Cancel semantics shift.** Today's `cancelTx` works pre-broadcast because we hold the controller. Once submitted to the relayer, the request is in flight server-side and can't be recalled. We'd need a `dismissTx`-style "stopped tracking" path (already exists for post-broadcast self-submitted txs; reuse).

### Phase B

- **Permit front-running**: someone watching the mempool sees the permit, calls `gaslessShield` themselves, swaps the `npk` for their own railgun address. Mitigation: `onlyRelayer` gate on the wrapper. Trivial.
- **Permit deadline**: too short → mid-flight permit expires while relayer queues. Too long → permit floats around if user changes mind. 10 min is the typical sweet spot.
- **Two-signature UX cost**: user signs both a permit AND the SHIELD_SIGNATURE_MESSAGE in quick succession. Worse than today's single shield prompt. Wallets show both as EIP-712 prompts back-to-back; the permit prompt looks like "Approve USDC: max 5 USDC to GaslessShieldWrapper" — reasonable but additional friction.
- **Audit surface**: the wrapper is a new contract on the critical path for first-time deposits. For mainnet rollout it needs review. For Sepolia POC it's acceptable as-is.

### Both phases

- **Relayer is now a hard dependency for transacting.** Today the user can self-submit if the relayer is down; with the dual-mode toggle we should keep that fallback. If we hardcode relayer-submit (Phase A's simpler path), relayer downtime blocks all txs. Worth a "submit from wallet" override surfaced when relayer health is `unhealthy` per `/health`.

---

## Open questions (defer until A starts)

- Does Railgun's broadcaster-fee mechanism handle a multi-output proof (e.g. transfer with change AND broadcaster fee = 3 commitments)? Need to verify the SDK populates `commitmentCiphertext` correctly and our vkey set covers `(N, 3)` shapes (it does after PR #301).
- Does the relayer's `eth_estimateGas` pre-flight reject correctly when the broadcaster fee is below the advertised threshold? Should fail at the contract level on revert; we want it to fail in the relayer's verifier BEFORE submission to save gas.
- How does the user signal their fee preference? Single quote today; might want "fast/standard/slow" tiers later. Out of scope for Phase A; the schema already supports cacheId-based selection.
