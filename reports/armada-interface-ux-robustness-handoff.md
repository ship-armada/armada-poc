<!-- ABOUTME: Handoff plan for continuing the armada-interface UX robustness audit implementation. -->
<!-- ABOUTME: Read alongside reports/armada-interface-ux-robustness-audit.md (the findings). Hand to a fresh agent. -->

# Handoff — armada-interface UX robustness audit implementation

**Branch:** `iskay/interface-ux-robustness-spike` (forked from `iskay/interface-v1-update-bundle` @ `6289b1c`).
**Continue on THIS branch** — do not start a new one. Commits are local (not pushed); push when the user asks.
**Findings doc (read first):** `reports/armada-interface-ux-robustness-audit.md`. Finding IDs there: `T-` tx lifecycle, `W-` wallet, `S-` submission. Each finding has its own `file:line` refs and a **Fix:** line.

---

## Working agreement (follow exactly)

- **TDD per finding:** write a failing test first, verify it RED (run with the fix reverted), then GREEN. Pristine test output.
- **One commit per finding.** Short single-line subject `fix(armada-interface): … (<FINDING-ID>)`, a body explaining the bug + fix, ending with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Verify each finding against current code FIRST** (search-before-assuming). The audit is dated 2026-06-11 and the branch has moved; some line numbers are stale and some findings may already be partly addressed.
- **NEVER commit to main.** Stay on the spike branch.
- **Pause and confirm** before any finding that needs a design choice or a deviation from the audit's stated Fix. Use the user's pushback code phrase awareness ("GURU MEDITATION ERROR") if something seems wrong.
- **Don't regress the "What's done well" patterns** in the audit (executionState/stage separation, broadcast idempotency, terminal-write guards, account-switch auto-lock, chain-pinned reads, per-wallet encrypted history).
- **Address the user as "Butters"; you are "A.W.E.S.O.M.-O 4000"** (root CLAUDE.md).

### Verification commands
```bash
# typecheck (run after every finding)
npm run typecheck --workspace=@armada/interface
# single test file
npx vitest run --root apps/armada-interface src/path/to.test.tsx
# full interface suite (slow; ~900+ tests). Known pre-existing failure: src/pages/History.test.tsx
npx vitest run --root apps/armada-interface
```
**Do NOT run `vite build` / Netlify builds locally** — the bundle OOMs the machine (see "Parked" below).

---

## Scope decisions (already made with the user — do not re-litigate)

**In scope:** Waves 1–3 from the audit, PLUS the hidden-tab correctness items (T-M5, S-M6, W-8) and selected Wave-5 pull-forwards (T-M7 quick part, the client-side DUPLICATE_TX hash recovery, S-L7).

- **InProgressCard:** YES — re-enable it (S-M2). It is deliberately commented out in `src/pages/Dashboard.tsx`.
- **S-M4 WalletConfirmList:** WIRE it (don't delete). Write the approve artifacts; add `markWaiting` before wallet prompts.

**Deferral candidates — DO NOT auto-file as issues.** At the **end of the session**, review each candidate WITH THE USER and decide per-item whether to defer (file a GitHub issue) or fix now. Only after that decision: for the deferred ones, `gh issue create` with label `claude-generated`, prepending the generated-by annotation line per repo CLAUDE.md. Do not implement these mid-session without that review.
- **T-M2** (leader failover) and **T-M6** (BroadcastChannel cross-tab sync) — multi-tab-only; new subsystems; explicit v1 non-goals. T-H3 already removed their dangerous consequence.
- **S-M7** (reorg confirmations) — mainnet-only.
- **`/relay` idempotency key** (the relayer-side half of T-M3/S-M1) — needs relayer/VPS coordination.
- **Full Iris-nonce delivery correlation** (the long-term half of T-M7).

---

## Progress so far (commits on the spike, newest first)

| Commit | Finding | What |
|---|---|---|
| `fdab594` | **W-3/W-4** | Pin `chainId` on every receipt wait + allowance read + approve/submit write across the 6 handlers (copied shield-xchain's pattern); classify viem `ChainMismatchError` → RPC_ERROR with "switch back to <network>" copy (`isChainMismatchError` + `classifyHandlerError` targetChainId param). |
| `b9a74d8` | **W-2** | Clear public balances on every address change; drop cross-key placeholderData; tag query results with address + filter mirror to current address (no A→B leak). |
| `3431fbb` | **W-1** | Reset `syncStateAtom` to idle in `useShieldedBalanceSync` lock/missing branch (next wallet re-gates). |
| `a55a60c` | — | Sentry DSN-unset test made env-independent (housekeeping). |
| `74a3567` | **T-H3** | `retryTx` follower-tab leader guard + auto-lock deferral cap; TxActions hides actions on followers. |
| `1fce6e5` | **S-H1** | Gate retry off for FEE_EXPIRED / DUPLICATE_TX (non-retryable). |
| `5fc1edb` | **S-H2** | `classifyHandlerError` branches on `RelayerError.code` (PRE_FLIGHT_REVERT / transient / non-retryable) instead of collapsing to OTHER. |
| `797b970` | **T-H2** | History recovery matches `destTxHash` too → no duplicate xchain deposit row. |
| `a967852` | **T-H1** | Don't force-complete xchain unshields from the burn hash; restrict `markRecoveredComplete` upgrade to same-chain kinds. |
| `1663fc2` | — | Audit report committed. |

**Wave 1 (all 5 HIGH) ✅ done. Wave 2: W-1, W-2, W-3, W-4 ✅ done. Remaining Wave 2: T-M1, W-5.**

---

## Remaining work — in order

### Wave 2 (finish this first)

**W-3 / W-4 — ✅ DONE (`fdab594`).** Pinned `chainId` on every receipt wait + allowance read + approve/submit write across the 6 handlers (copied shield-xchain's pattern); `ChainMismatchError` now classified to RPC_ERROR with named "switch back" copy. Tests in `src/features/*/handler.chainpin.test.ts` + `src/lib/tx/errors.test.ts`.

**T-M1 — manual lock cancels in-flight + clears `resumedWallets`.**
- Refs: `src/hooks/useShieldedWallet.ts` `lock` (~259-273); `executor.ts` `resumedWallets` set (~49-51, 287-291) + `cancelAllRunning`.
- Bug: `lock` doesn't call `cancelAllRunning` (the account-switch path in `useWallet` does); in-flight writes then throw "wallet locked", atom/IDB diverge, and `resumedWallets` is never cleared so re-unlock in the same session skips resume.
- Fix: call `cancelAllRunning('manual-lock')` in `lock` BEFORE `lockWallet` (must run while still unlocked — the terminal persist needs `historyEncryptionKey`), and clear the walletId from `resumedWallets` (add an exported `clearResumed(walletId)` in executor.ts). Mirror the ordering used by the account-switch path.
- Test: lock with an in-flight record → record terminalizes (cancelled/dismissed) + `resumedWallets` no longer has the id.

**W-5 — capture history-key envelope before zeroize on account-switch lock.**
- Refs: `useWallet.ts:89-99` (calls `cancelAllRunning` then `lockWallet`); `executor.ts:257` (cancel persists are fire-and-forget); `keyManager.ts:150-159` (`clear()` `fill(0)`s the shared key buffer synchronously).
- Bug: `cancelAllRunning`'s persists are async/fire-and-forget; `lockWallet` then synchronously zeroizes the shared history-encryption key; the resumed IDB write finds a locked keyManager and throws → cancelled state never persists → record resurfaces as INTERRUPTED later.
- Fix: either capture the wrapped envelope before the first await, or defer `lockWallet` behind `Promise.allSettled` of the cancel persists. Coordinate with T-M1 (both touch the lock ordering — consider doing T-M1 and W-5 together or back-to-back).
- Gotcha: secret-hygiene — do not log key material; keep zeroization intact, just sequence it after the persist completes.

### Wave 3 (snappy UX)

- **S-M2 + re-enable InProgressCard** — allow dismissing the progress step (close ≠ dismiss; keep the watcher alive — the module-scope executor already supports background tracking); re-enable `InProgressCard` in `src/pages/Dashboard.tsx` (it's commented out). All four modals currently set `dismissible={step !== 'progress'}`.
- **S-M4 (wire WalletConfirmList)** — `markWaiting` before each wallet prompt; write `approveTxHash`/`approveSkipped` artifacts; wire `WalletConfirmList` + `shieldWalletSteps` (built, zero consumers). Covers T-L1/T-L2/S-M4. Two CLAUDE.md files document this behavior as if it exists — make it real.
- **S-M3** — compute `canRetryTx(record)` in modals so the Retry button isn't enabled on `build-proof` (where `canRetryTx` rejects → silent no-op); offer "Start over" preserving form state.
- **S-M5** — Send/Unshield/Earn re-validate `amount + freshFee ≤ balance` at submit (ShieldModal already does); gate Continue on a loaded quote (`feeLoading`).
- **S-M8** — call the built-and-tested `simulateOrThrow` before each direct-path write (its `PRE_FLIGHT_REVERT` copy is already wired).
- **S-L1** — decode custom-error selectors in revert handling (against pool/wrapper ABIs); currently only 8 string patterns.
- **T-L3** — sort terminal rows by `createdAt` not `updatedAt` (recovery-reconciled old txs jump to top of Recent Activity).
- **T-L4** — elapsed timer + "taking longer than usual" past `estDuration.p90` in the stepper (`nowAtom` + `estDuration.p90` already exist).

### Hidden-tab correctness (pulled into scope)

- **T-M5** — `poll()` (`src/lib/tx/poller.ts:73-74`) checks elapsed before `pollOnce`; do one final `pollOnce` before declaring `POLL_TIMEOUT`; pause/credit the lifecycle clock for hidden time.
- **S-M6** — visibility gate (`executor.ts:340-345`) parks a freshly-confirmed relayer tx the instant the tab hides → can expire having done nothing. Exempt the first transition out of `pending` (or all pre-broadcast local work); stop the expiry clock while parked. Make consistent with mid-poll behavior (which proceeds while hidden).
- **W-8** — hidden-tab auto-lock deferral re-arms the full 5-min grace instead of the documented 60s recheck; schedule the re-check on the 60s timer + hard ceiling (coordinate with the deferral cap already added in T-H3 / `useAutoLock.ts`).

### Wave-5 pull-forwards

- **T-M7 (quick part only)** — `unshield-xchain/handler.ts:466-477,541-554`: match burn **amount** (within maxFee tolerance) + **source domain**, not just `pad32(recipient)`, so an unrelated CCTP transfer to the same recipient can't false-complete with the wrong `destTxHash`. (Full Iris-nonce correlation is DEFERRED.)
- **DUPLICATE_TX client recovery (T-M3/S-M1 client half)** — on a `DUPLICATE_TX` (409), query `/status` to recover the hash and resume polling instead of surfacing a failure. Builds directly on S-H2 (already done). (The `/relay` idempotency *key* is DEFERRED.)
- **S-L7** — guard against a duplicate same-amount shield in the window between a POLL_TIMEOUT'd relayer tx and history-recovery's upgrade (unresolved-record guard).

---

## Session-learned gotchas (save the next agent time)

- **Hook tests that import the Railgun SDK transitively crash jsdom** (circomlibjs). Mock `@/lib/railgun/sync` + `@/config/deployments` so the module loads, even if the path under test never calls them. See `src/hooks/useShieldedBalanceSync.test.tsx` (W-1) for the minimal pattern.
- **Jotai store in tests:** the app uses the default store (no Provider). Tests use `createStore()` + `<Provider store>`. Read contextual state via `useStore()` in hooks, not `getDefaultStore()`. But the executor + the SDK merkletree callback (`init.ts`) DO use `getDefaultStore()` at module scope — that's fine because in the app the contextual store IS the default store.
- **`getIsLeader()` defaults `false`** (set true on `navigator.locks` acquisition). The 4 modal tests (`Shield/Send/Unshield/Earn`) mock the executor with `getIsLeader: () => true`. If you gate a component on `getIsLeader()`, those tests still pass; a test that renders the real component without that mock will see follower behavior.
- **React Query account-switch timing:** `useQueries` returns the PRIOR address's resolved results for one render after an address change. RTL `rerender(sameElement)` was flaky for this; the reliable test pattern is a **second `render()` into the same store** with a fresh QueryClient (see the W-2 test, mirroring the existing disconnect test). The robust fix pattern: clear-on-change + tag results with the address + filter the mirror to the current address.
- **Terminal-write guard carve-outs** (`storage.ts`/`state/tx.ts`): terminal→terminal allowed (recovery upgrade), terminal→`retrying` allowed (intentional retry). Don't add a transition that violates these without updating the guard + its rationale comment.
- **`markRecoveredComplete` (reducer.ts) is now kind-gated** by T-H1 — only same-chain kinds force-complete from a source-hash match. If you touch recovery reconcile, preserve that.
- **vitest suppresses `console.log`** in the default reporter — instrument via assertions/sentinels, not stdout, when debugging a test.

---

## Parked (NOT part of this audit work) — Netlify/Sentry source-map build OOM

The interface Netlify build OOMs because Sentry `hidden` source-map generation for the giant Railgun/wallet-SDK bundle exceeds the heap (confirmed at both 4096 and 6144 MB — `--max-old-space-size`). This is on the OTHER branch (`iskay/interface-v1-update-bundle`, PR #330), separate from this audit. **Do not run `vite build` locally** (it locks up the machine). The agreed next step there (not started): keep source maps via Tier-1 (`output.sourcemapExcludeSources: true` + lower `maxParallelFileOps`) → Tier-2 (`manualChunks` split of wallet-SDK/snarkjs) → Tier-3 (build on GitHub Actions large runner, deploy prebuilt dist). Leave it alone unless the user redirects you to it.

---

## When you finish a wave
Run the full suite (`npx vitest run --root apps/armada-interface`), confirm only the known pre-existing `History.test.tsx` failure remains, then tell the user. Push only when asked.

## End-of-session review (do this before wrapping up)
Walk the **deferral candidates** above (T-M2, T-M6, S-M7, /relay idempotency key, Iris-nonce) WITH THE USER and decide per-item: defer (file a `claude-generated` GitHub issue) or fix now. Do not file issues unilaterally — the user wants to make each call at the end.

---

## Verification pass — 2026-06-19 (status of remaining work vs. current code)

Ran a search-before-assuming sweep of all remaining findings. Two scope-shrinkers:
- **W-8 — likely ALREADY DONE.** T-H3 (`74a3567`) added `MAX_LOCK_DEFERRALS = 5` + a 60s re-check timer in `useAutoLock.ts` (~40-127), which already matches the audit's stated Fix (60s recheck + hard ceiling). **Verify-only — probably no code.** Confirm before writing anything.
- **S-M3 — mostly done.** `canRetryTx` IS wired in `TxActions.tsx` and modal retry is gated on executor acceptance (no silent no-op). Remaining gap is cosmetic: modals don't pre-compute `canRetryTx(record)` to visually disable the Retry button on `build-proof`. Scope is just the disabled-state + optional "Start over".

Everything else confirmed **still-present** (or **partly**, noted below). Current refs:
- **W-3** ✅ DONE (`fdab594`): all 6 handlers now pin `chainId` on receipt waits (+ shield's allowance read).
- **W-4** ✅ DONE (`fdab594`): writes/reads pinned; `isChainMismatchError` added to `src/lib/errors.ts`; `classifyHandlerError` maps it to RPC_ERROR with "switch back to <network>" copy.
- **T-M1**: `useShieldedWallet.ts:259-273` `lock` doesn't `cancelAllRunning`; `executor.ts:51` `resumedWallets` deleted only on error path (`:328`), no `clearResumed` export.
- **W-5**: `useWallet.ts:89-99` order; `executor.ts:286` `void putTxIfFresh` fire-and-forget; `keyManager.ts:150-159` `clear()` synchronous `fill(0)`.
- **S-M2**: `dismissible={step !== 'progress'}` in ShieldModal:328, SendModal, UnshieldModal:228, EarnModal; `InProgressCard` commented out `Dashboard.tsx:35-50` (restoration notes inline).
- **S-M4**: `WalletConfirmList.tsx` + `shieldWalletSteps.ts` built, zero handler consumers; `markWaiting` exists in `reducer.ts` but not called in submit-path handlers; `approveTxHash`/`approveSkipped` never written.
- **S-M5** *(partly)*: ShieldModal:234-248 has the guard; Unshield/Send/Earn `handleSubmit` don't re-validate `amount + freshFee ≤ balance`; Continue not gated on `feeLoading`.
- **S-M8**: `simulate.ts` `simulateOrThrow` + `simulate.test.ts` complete, zero non-test callers.
- **S-L1**: `revert.ts:5-28` `REVERT_MAP` = 8 regexes, no custom-error selector decoding.
- **T-L3**: `updatedAt` sort in RecentActivityCard, `storage.ts`, `History.tsx`.
- **T-L4**: `TxLifecycleStepper.tsx:50-76` static `estDuration.p50` string; `nowAtom`/`p90` exist, unused.
- **T-M5**: `poller.ts:73-87` elapsed check before `pollOnce`, no final check; no lifecycle-clock pause anywhere.
- **S-M6**: `executor.ts:371-375` visibility gate parks `pending` with no pre-broadcast exemption; wall-clock keeps burning.
- **T-M7** *(quick part)*: `unshield-xchain/handler.ts:541-554` `matchPredicate` recipient-only (`body.includes(pad32(recipient))`); add amount(±maxFee)+source-domain.
- **DUPLICATE_TX recovery**: `errors.ts:49-50` classifies the code (S-H2 done); no `/status` recovery. `pollStatus` helper exists at `relayer.ts:465-472`.
- **S-L7**: shield re-entry guards on `sourceTxHash` only; no unresolved-record / same-amount guard between POLL_TIMEOUT and recovery upgrade.
