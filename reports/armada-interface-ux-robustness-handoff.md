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
| `62967ae` | **T-M1** | `useShieldedWallet.lock` now `cancelAllRunning('manual-lock')` + `clearResumed(activeId)` before `lockWallet`; new `clearResumed` export; account-switch path also clears the resume guard. |
| `a4ab073` | **W-5** | `putTxIfFresh` encrypts the envelope up-front (before the OCC-read await) so a cancel-during-lock zeroize can't lose the terminal write (no false INTERRUPTED). |
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

**Wave 1 (all 5 HIGH) ✅ done. Wave 2 (W-1, W-2, W-3, W-4, T-M1, W-5) ✅ ALL done. Next: Wave 3.**

---

## Remaining work — in order

### Wave 2 (finish this first)

**W-3 / W-4 — ✅ DONE (`fdab594`).** Pinned `chainId` on every receipt wait + allowance read + approve/submit write across the 6 handlers (copied shield-xchain's pattern); `ChainMismatchError` now classified to RPC_ERROR with named "switch back" copy. Tests in `src/features/*/handler.chainpin.test.ts` + `src/lib/tx/errors.test.ts`.

**T-M1 — ✅ DONE (`62967ae`).** `useShieldedWallet.lock` now `cancelAllRunning('manual-lock')` + `clearResumed(activeId)` before `lockWallet`; new `clearResumed` export in executor.ts; account-switch path in `useWallet` also clears the resume guard. Tests in `executor.test.ts`, `useShieldedWallet.test.tsx`, `useWallet.test.tsx`.

**W-5 — ✅ DONE (`a4ab073`).** Solved at the storage layer instead of the lock layer: `putTxIfFresh` encrypts the envelope up-front (before the OCC-read await), so a cancel-during-lock zeroize can't make the terminal write throw at write time. Lock timing/zeroize ordering untouched (beforeunload's synchronous zeroize preserved). Test in `storage.test.ts`.

### Wave 3 (snappy UX)

- **T-L3 — ✅ DONE (`9bee75a`).** Shared `historySortTime` helper (terminal → `createdAt`, in-flight → `updatedAt`) used by RecentActivityCard / History / `loadAllTx`.
- **S-M5 — ✅ DONE (`3151615`).** New `assertSpendableForFeeOnTop` helper; Send/Unshield/Earn re-validate `amount + freshFee ≤ balance` at submit. (Did NOT gate Continue on `feeLoading` — ShieldModal doesn't either, and the submit guard covers the failure; gating would diverge the modals.)
- **S-M3 — ✅ DONE (`4eb1825`).** Modals compute `canRetryTx(record)`: retryable → "Try again"; not retryable (build-proof / FEE_EXPIRED / DUPLICATE_TX) → **"Start over"** returning to the **Input** step (form preserved). `ErrorStep` gained a `primaryLabel` prop.
- **S-M8 — ✅ DONE (`aa67370`).** `simulateOrThrow` wired before each **main-action** user-wallet write across 7 handlers (skipped ERC20 approve per decision). Simulated against the pinned chainId + captured submitter.
- **S-M2 — ✅ DONE (`317e3c3`).** All four modals `dismissible={true}` — closing during progress backgrounds the tx (close() only resets modal state, never cancels; "Stop tracking" stays the explicit abort). InProgressCard re-enabled on the dashboard (documented 7/5 split beside Recent Activity) with CSS matched to RecentActivityCard. **Layout note:** went with the documented split — if stacked full-width is preferred, it's a small Dashboard.tsx edit.
- **T-L4 — ✅ DONE (`2f96eeb`).** `stepperEta` helper (lib/tx/eta.ts): live elapsed + "taking longer than usual" past p90; terminal records get no live ETA. Stepper reads `nowAtom`. (Test follow-up `317d77b` updated the History inline-stepper marker.)
- **S-M4 — ✅ DONE (`c1e4643`).** shield + shield-xchain DIRECT paths call `markWaiting` before each wallet prompt (approve, then shield/crossChainShield) → "Confirm in your wallet" reachable; flips back to active for the receipt wait. `approveTxHash`/`approveSkipped` written to artifacts (added the fields to ArtifactsShield/ArtifactsShieldXchain — shieldWalletSteps had been reading them via a cast). `shieldWalletSteps` gasless branch = single "Authorize deposit" row (done once build-proof captures the permit). `WalletConfirmList` rendered in ProgressStep for shield kinds. Gasless submit paths unchanged (relayer broadcasts; no submit prompt).
- **S-L1 — ✅ DONE (`a0a6ef8`).** New `lib/tx/revertSelectors.ts` decodes the Solidity-standard `Error(string)` + `Panic(uint256)` from a raw `0x<selector>` payload (overflow/div-by-zero/array-bounds → friendly copy). `classifyHandlerError` extracts the revert hex (`err.data` / nested cause / message blob) and decodes it; decoded reasons still run through `mapRevertToMessage`. The duplicated `revert.ts` was left untouched (kept in sync with crowdfund-shared). **Confirmed during impl:** the ~61 custom errors are governance-only — the user-facing contracts (pool/client/railgun/wrappers/yield) use string `require`s, so the standard-selector ABI covers every selector these flows emit.
- **W-4 follow-up (`3e7f82c`)** — the W-3/W-4 sweep had missed shield-xchain's direct-path approve `readContract`+`writeContract` chainId pins; fixed.

**Wave 3 COMPLETE.** Full suite: 1020 passed, 8 skipped, only the known pre-existing `History.test.tsx` ("filters in completed records") failure remains.

### Hidden-tab correctness (pulled into scope) — ✅ COMPLETE

- **W-8 — ✅ DONE (`ba661cf`).** Hidden-tab deferral re-checks on a clean 60s timer (`hiddenLockCheck`) instead of re-arming the full 5-min grace; bounded by the T-H3 cap (~10min not ~30min).
- **T-M5 — ✅ DONE (`2392f2c`).** `poll()` checks the budget AFTER each `pollOnce`, so a delivery that landed during a hidden-throttled interval gets a final check instead of a false `POLL_TIMEOUT`.
- **S-M6 — ✅ DONE (`f4c4677`).** Visibility gate only engages once the tx has broadcast (has `sourceTxHash`); pre-broadcast work proceeds while hidden. retryTx tests now freeze via a parking handler.
- **Clock-credit — ✅ DONE (`aa0e0d0`).** New `lib/tx/hiddenClock.ts` credits per-record tab-hidden time against the expiry check + `pollBudgetMs` (both xchain delivery polls now route through it). Untracked records credit 0 (graceful degrade). Fed by `useTabVisible`.

### Wave-5 pull-forwards

- **T-M7 (quick part) — ✅ DONE (`72eca15`).** `matchesXchainDelivery` (pure, in `scan.ts`) additionally requires the CCTP `sourceDomain` to be the hub's domain. Burn-amount-within-maxFee match stays DEFERRED to full Iris-nonce correlation (needs BurnMessage byte-offset parsing; wrong offset would break detection).
- **DUPLICATE_TX client recovery — ✅ DONE (`7a12e64`).** The relayer reports the existing hash in the 409 message, so recovery is fully client-side (no relayer change needed — the handoff's "/status" assumption was moot). `extractDuplicateTxHash` + `handleRelaySubmitError` (used by all 7 relayer-submit handlers) recover the hash and resume polling. `/relay` idempotency *key* stays DEFERRED.
- **S-L7 — NOT STARTED. Needs a UX decision** (see below).

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
- **T-M1** ✅ DONE (`62967ae`): manual lock + account-switch now cancel in-flight and clear the resume guard.
- **W-5** ✅ DONE (`a4ab073`): fixed at the storage layer (`putTxIfFresh` encrypts before the OCC-read await) rather than re-sequencing the lock.
- **S-M2**: `dismissible={step !== 'progress'}` in ShieldModal:328, SendModal, UnshieldModal:228, EarnModal; `InProgressCard` commented out `Dashboard.tsx:35-50` (restoration notes inline).
- **S-M4**: `WalletConfirmList.tsx` + `shieldWalletSteps.ts` built, zero handler consumers; `markWaiting` exists in `reducer.ts` but not called in submit-path handlers; `approveTxHash`/`approveSkipped` never written.
- **S-M5** ✅ DONE (`3151615`) — see Wave 3.
- **S-M8** ✅ DONE (`aa67370`) — see Wave 3.
- **S-L1**: still 8 regexes — BLOCKED on the error-ABI decision (see Wave 3 entry).
- **T-L3** ✅ DONE (`9bee75a`) — see Wave 3.
- **S-M3** ✅ DONE (`4eb1825`) — see Wave 3.
- **T-L4**: `TxLifecycleStepper.tsx:50-76` static `estDuration.p50` string; `nowAtom`/`p90` exist, unused.
- **T-M5**: `poller.ts:73-87` elapsed check before `pollOnce`, no final check; no lifecycle-clock pause anywhere.
- **S-M6**: `executor.ts:371-375` visibility gate parks `pending` with no pre-broadcast exemption; wall-clock keeps burning.
- **T-M7** *(quick part)*: `unshield-xchain/handler.ts:541-554` `matchPredicate` recipient-only (`body.includes(pad32(recipient))`); add amount(±maxFee)+source-domain.
- **DUPLICATE_TX recovery**: `errors.ts:49-50` classifies the code (S-H2 done); no `/status` recovery. `pollStatus` helper exists at `relayer.ts:465-472`.
- **S-L7**: shield re-entry guards on `sourceTxHash` only; no unresolved-record / same-amount guard between POLL_TIMEOUT and recovery upgrade.

---

## Remaining LOW findings — consciously deferred, NOT filed as issues

Decision (2026-07): the audit's HIGH + MEDIUM findings are all implemented or filed. The two
trivial LOWs left were pulled in — **T-L5** (`83883dab`, shield-xchain dest explorer link) and
**T-L9** (`66e1ccff`, removed the unused `useCctpAttestation` stub). The remaining LOW-severity
items are **intentionally left unimplemented and NOT filed as GitHub issues** (the tracker is
already large); recorded here instead so they're not lost:

| ID | Finding | Why deferred (not trivial) |
|---|---|---|
| T-L6 | Retry offered when predictably futile (expired xchain re-fails fast) | Partly covered by S-H1 (fee-past-TTL gated); the xchain-expired part needs `canRetryTx` tightening |
| T-L7 | `putTxIfFresh` OCC is non-atomic read-then-write | Self-healing; only wants a single-txn put or a documented acceptance |
| T-L8 | INTERRUPTED copy ignores a mined approve leg | Needs to detect a confirmed approve before the interrupt — non-trivial |
| W-6 | `signIn` click-to-prompt race stores identity under wrong key | Security-sensitive; assert active account after `promptSign()` across the signIn flow |
| W-7 | `useWallet` switch effects run per mounted consumer; drop unused `signer` | Refactor into a mount-once `useAccountSwitchGuard()` |
| W-9 | No wallet affordance below the `sm` breakpoint (mobile) | New responsive UI (`_unused` mobile-sheet state exists) |
| W-10 | WalletConnect dead-ends on the placeholder project id | Needs a real WC project id or hiding WC connectors when unset |
| S-L2 | `useFees().isUnavailable` has no consumers | Wire the relayer-fees-down signal into the fee row |
| S-L3 | Proof generation isn't actually cancellable | "Document it" — no clean home; WASM prover has no abort hook |
| S-L4 | A declined MetaMask prompt persists as a permanent "failed" row | `cancelled` semantics across all 8 handlers' catch + preserve copy |
| S-L5 | No stuck/underpriced-tx replacement path | POLL_TIMEOUT copy could suggest "speed up in your wallet" (speculative) |
| S-L6 | `StageHandler.resumableFrom` is dead code | Removal cascades to the interface + all 7 handlers + every test literal |

**Also deferred, not filed:** T-M6 (BroadcastChannel cross-tab sync) — multi-tab v1 non-goal;
T-H3 already removed the dangerous consequence. (T-M2 → #327, T-M4 → #328, S-M7 → #336 are filed.)
