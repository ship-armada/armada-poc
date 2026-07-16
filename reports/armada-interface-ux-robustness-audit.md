# Armada Interface — UX Robustness Audit

<!-- ABOUTME: Consolidated audit of armada-interface tx lifecycle, wallet handling, and tx submission/result UX. -->
<!-- ABOUTME: Generated 2026-06-11 by Claude Code from three parallel deep-dive reviews; findings reference file:line in apps/armada-interface. -->

**Date:** 2026-06-11
**Scope:** `apps/armada-interface` — (1) tx lifecycle & cross-chain status tracking, (2) wallet connection / disconnection / account & network switching, (3) tx submission & result handling.
**Method:** Three parallel code-reading agents, one per area, each reading the lifecycle model (`src/lib/tx/`), handlers (`src/features/*/handler.ts`), wallet layer (`src/hooks/useWallet.ts`, `useShieldedWallet.ts`, `keyManager`), and UI surfaces end-to-end. All paths relative to `apps/armada-interface/`.

---

## Executive summary

The architecture is genuinely strong: the per-kind lifecycle model with `executionState` separate from protocol `stage`, broadcast idempotency (persist hash before any wait, re-entry resumes watching instead of re-sending), the honest cancel/dismiss/timeout error taxonomy, terminal-write guards at both the atom and IDB layers, and address-bound auto-lock on account switch are all production-grade patterns. The findings below are mostly gaps at the seams between subsystems, plus a cluster of "built but never wired" UX affordances.

**Three cross-cutting themes cause most of the high/medium findings:**

1. **Two independent writers of terminal truth.** The executor's chain watchers and the history-recovery scanner both write terminal states with no shared rule about what on-chain evidence proves which stage. This produces false "Funds delivered" on cross-chain unshields (T-H1), duplicate deposit rows (T-H2), and timeout-vs-recovery disagreements (T-M5). One "evidence → maximum provable stage" table per kind, used by both writers, fixes the class.
2. **Relayer error codes are built, transported, and then discarded.** `RelayerError` carries a rich typed code set; `classifyHandlerError` never branches on it, so everything collapses to "Something went wrong" — including the fee-expired case where the offered Retry is structurally guaranteed to fail forever (S-H1, S-H2).
3. **Multi-tab and hidden-tab behavior fights the lifecycle clock.** No leader failover, no cross-tab sync, an unguarded Retry path in follower tabs, a visibility gate that stalls work while the wall-clock expiry keeps burning, and a poll loop that times out without one final check — together these can fail txs that succeeded and wedge records that disable auto-lock (T-H3, T-M2, T-M5, T-M6, S-M6, W-8).

Finding IDs: **T-** = tx lifecycle/tracking, **W-** = wallet, **S-** = submission/result.

---

## HIGH severity

### T-H1. History recovery force-completes in-flight cross-chain unshields — false "Funds delivered"
`src/hooks/useHistoryRecovery.ts:70-89`, `src/lib/tx/reducer.ts:133-152` (`markRecoveredComplete`), `src/lib/railgun/history.ts:281-312`

The hub burn of an `unshield-xchain` appears in the SDK's history with the same txid as the record's `sourceTxHash`. The SDK balance event fires the moment the burn syncs, the scan finds the non-terminal record, and the reconcile path calls `markRecoveredComplete` — jumping the stage to `client-mint-confirmed` (`completed`) while CCTP delivery on the destination chain hasn't happened and may never happen (Iris outage, relayer down). A previously-failed `POLL_TIMEOUT` record gets upgraded to permanent false success on the next scan. The terminal-write guard then blocks the executor's honest `waiting` updates.

**Fix:** restrict the reconcile-upgrade to kinds whose hub-side evidence proves terminal success (shield, unshield-local, transfer-shielded, yield). For xchain kinds, hub evidence may at most advance to `hub-burn-confirmed` / re-arm delivery polling.

### T-H2. Duplicate "Deposit" row for every cross-chain shield
`src/hooks/useHistoryRecovery.ts:221-222`, `src/features/shield-xchain/handler.ts:668`, `src/lib/railgun/history.ts:129-156`

`findExistingByHash` only matches `artifacts.sourceTxHash` (client-chain burn), but the hub mint the SDK sees has the txid stored in `artifacts.destTxHash`. So every completed cross-chain shield synthesizes a second, permanent "Deposit" row. If the authored record had expired, the user sees one failed and one completed deposit for the same funds. This is the common path (the detector fires on the mint's own balance event), not an edge case.

**Fix:** match on `destTxHash` too, and/or skip synthesizing a shield row when an active `shield-xchain` record covers that txid.

### T-H3. `retryTx` lacks the follower-tab guard — wedges records in `retrying` and disables auto-lock
`src/lib/tx/executor.ts:161-183`, `src/components/tx/TxActions.tsx:66-74`, `src/hooks/useTx.ts:56-61`, `src/hooks/useAutoLock.ts:69-77`

`useTx.submit` refuses follower-tab submits with a toast, but Retry in `TxActions` calls `executor.retryTx(id)` directly: the record is marked `retrying` and persisted, then `executeTx` silently no-ops on a non-leader. Result: a permanently non-terminal record showing "Retrying" forever, counted by `pendingTxsAtom`, so `useAutoLock` defers the security lock indefinitely — a stuck UI row silently keeps keys in memory. Follower `cancelTx`/`dismissTx` have related races.

**Fix:** add the same leader guard + toast to `retryTx`; hide/disable Retry/Cancel on follower tabs; cap auto-lock deferral so one wedged record can't hold the wallet unlocked forever.

### S-H1. Retry after relayer fee rejection is structurally futile — infinite failure loop offered to the user
`src/features/unshield/handler.ts:193-221`, `src/hooks/useTx.ts:79-94`, `src/lib/tx/lifecycles.ts:24`, `src/lib/tx/executor.ts:144-183`

Fee `cacheId` + `broadcasterFeeAmount` are frozen into meta at submit (correctly — the proof embeds them). If the relayer rejects with `FEE_EXPIRED` (slow proof gen racing the 5-min TTL — anticipated in the handler's own comment) or `FEE_INSUFFICIENT`, the record fails at `submit-relayer`, which is a retryable stage. "Try again" re-POSTs the same expired cacheId with the same baked-in fee — guaranteed to fail again, forever. Nothing tells the user the only recovery is a new transaction.

**Fix:** classify fee codes as non-retryable with "quote expired — start a new transaction" copy, or make retry re-quote and re-enter `build-proof` (safe pre-broadcast).

### S-H2. `RelayerError.code` is discarded — all relayer rejections collapse to "Something went wrong"
`src/lib/tx/errors.ts:22-43`, `src/config/relayer.ts:14-29`, `src/lib/revert.ts:16-17`

The relayer client builds typed errors (`GAS_ESTIMATION_FAILED`, `DUPLICATE_TX`, `RELAYER_BUSY`, fee codes…), handlers even emit the code to telemetry, but `classifyHandlerError` never branches on `RelayerError` — everything becomes `OTHER`. `GAS_ESTIMATION_FAILED` deserves PRE_FLIGHT_REVERT semantics ("nothing was sent"); `DUPLICATE_TX` (409) means "already submitted — poll status" but surfaces as a failure; `RELAYER_BUSY` is transient and retry-appropriate.

**Fix:** add a `RelayerError` branch mapping codes to typed `TxError`s.

---

## MEDIUM severity

### Tx lifecycle & tracking

- **T-M1. Manual lock mid-flight strands records until full reload.** `useShieldedWallet.lock` (`src/hooks/useShieldedWallet.ts:259-273`) doesn't call `cancelAllRunning` (the account-switch path does); writes then throw "wallet locked", atom and IDB diverge, and `resumedWallets` (`executor.ts:49-51,287-291`) is never cleared on lock, so re-unlock in the same session skips resume. **Fix:** `cancelAllRunning('manual-lock')` in lock + clear the walletId from `resumedWallets`.
- **T-M2. Leader election never fails over.** `startEngine` (`executor.ts:72-98`) requests the `navigator.locks` lock once with `ifAvailable: true`; when the leader tab closes, no surviving tab is promoted — in-flight 60-minute xchain watches freeze and submits are refused with "switch to your first tab" (which no longer exists) until a manual reload. **Fix:** a parallel queued lock request that promotes a follower (`onBecomeLeader` + resume).
- **T-M3 / S-M1. "Nothing left your wallet" can be a lie.** Resume marks hashless records `INTERRUPTED` (`executor.ts:321-327`), but the tab can die between wallet/relayer broadcast and the IDB hash write; the relayer 30s response timeout (`src/lib/relayer.ts:414-422`) throws with no txHash even when the relayer broadcast — for a gasless shield the permit is already consumed (USDC pulled). User is told the opposite of what happened; a retry hits 409 `DUPLICATE_TX`, which per S-H2 surfaces as another opaque failure instead of recovering the hash. **Fix:** on `DUPLICATE_TX`, query `/status` to recover the hash and resume polling; persist a `broadcastAttemptedAt` artifact before invoking wallet/relayer; soften INTERRUPTED copy for records that died inside the submit stage; consider a client-generated idempotency key on `/relay`.
- **T-M4. Resume into a collapsed xchain stage busy-spins the executor.** Handler switches (`src/features/unshield-xchain/handler.ts:147-164`, same in shield-xchain) have no cases for the intermediate `iris-attestation-ready`/`client-mint-pending` stages persisted by the delivery routine; `runHandlerChain` re-calls `run` in an await-only microtask loop — frozen tab until wall-clock expiry. **Fix:** re-enter `runWaitForDelivery` from intermediate stages, or detect no-progress in the chain loop and fail with telemetry.
- **T-M5. Poll timeout fires without a final check; lifecycle clock runs while hidden.** `poll()` checks elapsed time before `pollOnce` (`src/lib/tx/poller.ts:73-74`); hidden-tab timer throttling means a backgrounded user returns to `POLL_TIMEOUT` for a delivery that landed during the hidden period. **Fix:** one last `pollOnce` before declaring timeout; pause (or credit) the lifecycle clock for hidden time.
- **T-M6. No cross-tab state propagation.** Followers hydrate once per unlock and never see leader writes — stale "Preparing transaction" rows forever, exactly where the unguarded Retry/Cancel buttons live. **Fix (cheap):** `BroadcastChannel` ping from `ctx.upsert` → re-run `loadAllTx`, or re-hydrate on focus.
- **T-M7. Cross-chain delivery matching can false-positive.** Unshield-xchain delivery matches any destination `MessageReceived` whose body contains `pad32(recipient)` (`src/features/unshield-xchain/handler.ts:466-477,541-554`) — any unrelated CCTP transfer to the same recipient in the window completes the record with the wrong `destTxHash`. Amount isn't checked though recoverable. **Fix:** match burn amount (within maxFee tolerance) + source domain; long-term, nonce-correlated matching via real Iris polling.

### Wallet

- **W-1. `syncStateAtom` never reset on lock/account switch — sync and spend gates bypassed for the next wallet.** (`src/state/wallet.ts:72`, `useShieldedBalanceSync.ts:43-49`, `SyncGate.tsx:15-17`, `useSpendableSyncGate.ts:34-51`.) After A's scan completes, B's dashboard renders ungated with null balance and enabled spend buttons until the SDK's first scan event. **Fix:** reset sync state to `idle` in the locked/missing branch.
- **W-2. Previous account's public balances leak across a switch.** `useUsdcBalances.ts:103,110-121` — function-form `placeholderData` carries the old address's balances into the new key, and the atom is only wiped on disconnect (not A→B). User B briefly sees A's USDC in the wallet pill and can MAX-fill it in ShieldModal. **Fix:** clear the atom on every address change; don't reuse placeholder data across addresses.
- **W-3. Receipt waits not chain-pinned in 6 handlers.** `waitForTransactionReceipt` without `chainId` follows the wallet's current chain (`src/lib/tx/receipt.ts:17`; call sites in shield/unshield/transfer-shielded/yield-deposit/yield-withdraw/unshield-xchain handlers). A mid-wait network switch in MetaMask retargets polling to a chain where the hash doesn't exist → false `POLL_TIMEOUT` for a tx that succeeded. shield-xchain shows the correct pinned pattern. **Fix:** pass `chainId` at every `waitForReceiptOrFail` call site.
- **W-4. Submit-path reads/writes not chain-pinned either.** Allowance reads, approve/shield writes etc. rely on `ensureChain` having settled, but its settle-poll can time out and the user can flip chains in the gap (`network-switch.ts:171-174`; handler call sites in finding). Unpinned actions silently follow the new chain (wrong-chain allowance read → spurious max-approve prompt; writes target chains where contracts don't exist). **Fix:** pin `chainId` everywhere; map `ChainMismatchError` to "switch back to X" copy.
- **W-5. Account-switch lock zeroizes the history-encryption key under in-flight cancel persists.** `useWallet.ts:89-99` calls `cancelAllRunning` (whose persists are fire-and-forget, `executor.ts:257`) then `lockWallet` which synchronously `fill(0)`s the shared key buffer (`keyManager.ts:150-159`); the resumed IDB write finds a locked keyManager and throws — cancelled state never reaches disk, record resurfaces as `INTERRUPTED` later. **Fix:** capture the wrapped envelope before the first await, or defer `lockWallet` behind `Promise.allSettled` of the persists.

### Submission & result

- **S-M2. Progress step holds the user hostage for up to 60 minutes.** All four modals set `dismissible={step !== 'progress'}`; Escape disabled; the only post-broadcast affordance is "Stop tracking" which aborts the watcher entirely. The module-scope executor fully supports background tracking — the UI forbids it, and the one surface that would show backgrounded txs (`InProgressCard`, `src/pages/Dashboard.tsx:36-47`) is commented out. **Fix:** allow dismissal during progress (close ≠ dismiss), keep watcher alive, re-enable InProgressCard.
- **S-M3. "Try again" silently no-ops on build-proof failures; inputs lost.** Modals render an enabled Retry for stage `build-proof`, which `canRetryTx` rejects — clicking does nothing visible; closing the modal wipes the form. **Fix:** compute `canRetryTx(record)` in modals; offer "Start over" preserving form state.
- **S-M4 / T-L1. "Confirm in your wallet" copy is unreachable; approve+shield double-prompt invisible.** No handler ever calls `markWaiting` around wallet prompts, so the stepper shows "Submitting transaction" while MetaMask waits (possibly twice: approve then shield). `WalletConfirmList` + `shieldWalletSteps` were built exactly for this and have zero consumers; the `approveTxHash`/`approveSkipped` artifacts they read are never written. Two CLAUDE.md files document behavior that doesn't exist. **Fix:** `markWaiting` before each prompt; wire or delete `WalletConfirmList`; write the approve artifacts.
- **S-M5. Send/Unshield/Earn don't re-validate balance against the fresh quote at submit.** Fee-on-top flows refresh the quote on Confirm and freeze a possibly-higher fee without re-checking `amount + newFee ≤ balance` (ShieldModal has the guard; the others don't) — user burns 20-30s of proof gen ending in an opaque SDK throw. Continue isn't gated on `feeLoading`, so pre-quote `inputMax` equals full balance. **Fix:** mirror ShieldModal's re-check; gate Continue on a loaded quote.
- **S-M6. Hidden tab stalls the handler chain before any work starts while the budget burns.** The visibility gate at the top of the chain loop (`executor.ts:340-345`) parks a freshly-confirmed tx if the user immediately switches tabs; relayer-mediated flows need no further interaction, yet sit at `pending` and can expire having done nothing. Inconsistent with mid-poll behavior, which proceeds while hidden. **Fix:** exempt the first transition out of `pending` (or all pre-broadcast local work); stop the expiry clock while parked.
- **S-M7. One-confirmation success, no reorg awareness.** viem default 1 confirmation, terminal `completed` written immediately. Fine for Anvil/Sepolia; not for mainnet value. **Fix:** per-network `confirmations` in config.
- **S-M8. `simulateOrThrow` is fully built and tested but dead.** Zero callers; its own docstring describes the exact MetaMask 30M-gas-fallback bug it was written to fix, and the `PRE_FLIGHT_REVERT` copy is wired and waiting. **Fix:** call it before each direct-path write.

---

## LOW severity (abbreviated)

- **T-L2.** `approveTxHash`/`approveSkipped` read by `shieldWalletSteps` but never written (covered by S-M4).
- **T-L3.** History sort key is `updatedAt`; recovery-reconciled week-old txs leap to the top of Recent Activity. Sort terminal rows by `createdAt`.
- **T-L4.** Stepper ETA is a static p50 ("Usually takes ~30 sec") 25 minutes into a slow attestation — no elapsed timer, no "taking longer than usual" past p90, no relayer health surfaced during the wait. `estDuration.p90` and `nowAtom` already exist.
- **T-L5.** Destination explorer link wrong chain for `shield-xchain` (`TxLifecycleStepper.tsx:211-216` falls back to source chain → dead link).
- **T-L6.** Retry offered when predictably futile: expired xchain records re-fail in ~10s (`pollBudgetMs` floor); fee-bearing retries past TTL guarantee FEE_EXPIRED (see S-H1).
- **T-L7.** `putTxIfFresh` OCC is non-atomic read-then-write; atom written before IDB await with no rollback. Self-healing but worth a single-transaction put or a documented acceptance.
- **T-L8.** INTERRUPTED copy ignores a mined approve leg (gas spent, unlimited allowance granted, told "nothing left your wallet").
- **T-L9.** `useCctpAttestation` is a stub returning hardcoded `'pending'` — remove per hooks/CLAUDE.md.
- **W-6.** Click-to-prompt race in `signIn`: switching accounts between click and approval stores B's identity under A's localStorage key; A's next sign-in dead-ends in `NonDeterministicSignerError('cached-checksum-mismatch')`. Assert the active account after `promptSign()`.
- **W-7.** `useWallet`'s switch side effects run once per mounted consumer (`wallet.connected` telemetry fires N×); the exposed ethers `signer` has zero consumers and invites stale-closure capture. Split into a mount-once `useAccountSwitchGuard()`; drop `signer`.
- **W-8.** Hidden-tab auto-lock deferral re-arms the full 5-min grace instead of the documented 60s recheck; combined with the executor's hidden-pause, in-flight txs can hold keys in memory for as long as the tab stays hidden. Schedule the lock re-check on the 60s timer; add a hard ceiling.
- **W-9.** No wallet affordance below the `sm` breakpoint — mobile users cannot connect, see wrong-network, or disconnect (`AppLayout.tsx:48,53`; the `_unused` mobile-sheet state suggests this is known).
- **W-10.** WalletConnect dead-ends with the placeholder project id — QR spinner that never connects, no explanation (`config/wagmi.ts:63`). Fail loudly or hide WC connectors when unset.
- **S-L1.** Revert decoding is shallow (8 string patterns, no custom-error selector decoding); raw `0x<selector>` payloads can reach ErrorStep. Decode against pool/wrapper ABIs.
- **S-L2.** `useFees().isUnavailable` (relayer-fees-down signal, built per P1-28) has no consumers — fee row shows indefinite "loading…" when /fees is failing.
- **S-L3.** Proof generation isn't actually cancellable (no SDK abort hook) — Cancel leaves the WASM prover burning CPU. UI state is correct; document it.
- **S-L4.** A declined MetaMask prompt persists as a permanent "failed" History row; `cancelled` semantics fit better.
- **S-L5.** No stuck/underpriced-tx replacement path; POLL_TIMEOUT copy could suggest "speed up in your wallet".
- **S-L6.** `StageHandler.resumableFrom` is dead code (acknowledged WS7 cleanup).
- **S-L7.** In the window between a POLL_TIMEOUT'd relayer tx and history-recovery's upgrade, nothing blocks a duplicate same-amount shield (two real deposits). Consider an unresolved-record guard.

---

## What's done well (preserve these patterns)

- `executionState` vs protocol `stage` separation — one stepper/chip/reducer serves 8 kinds.
- Broadcast idempotency (P0-1): hash persisted before any wait; retry/resume re-watch, never re-send. `recordBroadcastHash` folds a post-cancel broadcast into `DISMISSED` instead of losing the hash.
- Terminal-write guards at both atom and IDB layers, with reasoned carve-outs.
- Honest error taxonomy: CANCELLED vs DISMISSED vs POLL_TIMEOUT vs PRE_FLIGHT_REVERT vs TX_REVERTED, typed/branded `TxError`s, explorer links on uncertainty.
- Account-switch auto-lock: address-bound unlock, `cancelAllRunning` + key zeroization + deduped toasts with distinct disconnect/switch copy.
- Multi-chain reads pinned to explicit chainIds with address+chain query keys; no wallet-chain-following reads.
- `ensureChain`: raw EIP-1193 switch, EIP-3085 add-chain fallback, friendly rejection copy, settle polling; chain re-asserted at submit time.
- Per-wallet AES-256-GCM-encrypted history; foreign-wallet records skip on unwrap; `txListAtom` physically reset on wallet change.
- Layered double-submit protection: `submittingRef`, executor running-map, ulid idempotency, follower-tab submit refusal.
- Bounded log scans with persisted cursors; relayer 404 → RPC receipt fallback; poll budgets derived from remaining lifecycle with `tx.budget.tight` telemetry.
- Fee staleness handled skew-immune at the modal boundary (4-min client clock under 5-min server TTL, re-quote on Confirm).
- Exact bigint amount parsing, EIP-55/bech32m validation at the funds-committing boundary, fee-aware `inputMax`, sync gate on spends.
- No flash-of-disconnected-state (RainbowKit `mounted` gating); chain-agnostic EIP-712 enrollment domain with determinism double-sign guard.

---

## Suggested fix order

**Wave 1 — correctness of displayed truth (high, small diffs):**
T-H1, T-H2 (evidence-table rule for recovery reconcile), S-H2 (RelayerError branch), S-H1 (fee-expired non-retryable), T-H3 (follower retry guard).

**Wave 2 — switch/lock hygiene (medium, localized):**
W-1 (sync state reset), W-2 (balance leak), W-3/W-4 (chain pinning — mechanical), T-M1 (manual-lock cancel + resume reset), W-5 (persist-before-zeroize).

**Wave 3 — snappier UX (the user-perceived wins):**
S-M2 + InProgressCard re-enable (background tracking), S-M4 ("Confirm in your wallet" + WalletConfirmList), S-M3 (retry no-op), S-M5 (fresh-quote balance check), T-L4 (elapsed/overdue ETA), S-M8 (simulateOrThrow), S-L1 (revert decoding).

**Wave 4 — multi-tab/hidden-tab model (design decision needed):**
T-M2 (leader failover), T-M6 (BroadcastChannel sync), T-M5/S-M6 (hidden-time budget credit + final poll), W-8 (auto-lock deferral ceiling).

**Wave 5 — pre-mainnet:**
S-M7 (confirmations), T-M7 (delivery match tightening), T-M3/S-M1 (idempotency key on /relay + DUPLICATE_TX hash recovery), S-L7 (duplicate-deposit guard).
