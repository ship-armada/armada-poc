# components/shield/

The **Shield / Unshield** tabbed flow — deposit (public → private) OR unshield (private → your own
EVM wallet), as two tabs on the amount step. Owned by `ShieldModal`, opened via `setOpenModal('shield')`
(Shield tab) or `setOpenModal('unshield')` (Unshield tab).

## Contents

| Component | Purpose |
|---|---|
| `ShieldModal` | **Dumb renderer** — open/close chrome + per-tab step rendering. Composes two controller hooks: `hooks/useShieldFlow.ts` (Shield) + `hooks/useUnshieldFlow.ts` (Unshield). The typed amount carries across the tab toggle. |
| `ShieldAmountStep` | Shared amount step (`ShieldAmountStepContent` + `Footer`) — `DepositAmountCard` with the Shield/Unshield `SegmentedControl` in its header + a chain picker (source for shield / destination for unshield) + `GasBalanceNotice` (wallet-submit). Direction-driven title/aria; footer gates Review on amount (+ shield's fee floor). Replaced the retired `ShieldInputStep`. |
| `ShieldReviewStep` / `ShieldCompleteStep` | **Shield direction** — frost card + `DepositReviewSummary`. |
| `ShieldWalletStep` | Dedicated **Wallet** step (the mockup's step 3) — the live approve/sign checklist (`WalletConfirmList` + `lib/tx/shieldWalletSteps`). Title transitions "Preparing your deposit…" (proof building) → "Confirm in your wallet" (a prompt is live). Shield tab only; Unshield is relayer-submitted. |
| (unshield direction review/complete) | Reuses `payments/SendReviewStep` + `SendCompleteStep` with `variant="withdraw"` (the "Review your USDC unshield" / "USDC unshield confirmed" copy). |

## State machinery

- `openModalAtom === 'shield' \|\| 'unshield'` controls visibility; the value picks the initial tab.
- **Shield tab** → `useShieldFlow`: `shield` / `shield-xchain` by from-chain; wallet-signs (or gasless permit).
- **Unshield tab** → `useUnshieldFlow`: `unshield-local` / `unshield-xchain` by **to-chain picker**; recipient is pinned to the connected wallet; relayer-submitted.
- **Shield** step machine: `'input' → 'review' → 'wallet' → 'progress' → 'complete'` (or `'error'`). The `wallet` step shows the approve/sign checklist; `useShieldFlow` advances it → `progress` once `shieldWalletInteractionsComplete(record)`. Step indicator has 4 segments (Amount/Review/Wallet/Confirm).
- **Unshield** step machine: `'input' → 'review' → 'progress' → 'complete'` (no wallet step; relayer-submitted). 3-segment indicator.
- Each controller owns its chain + step + submit; the shared `amountStr` lives at the modal and is synced across the toggle.

**Relationship to Send:** unshielding to your OWN wallet lives here (Unshield tab). Sending to an
arbitrary `0x`/`0zk` recipient is the Send flow (`payments/`, "send" copy). Both public paths are
`unshield-*` on-chain — the distinct copy is intentional (withdraw-to-self vs pay-someone).

## Wallet-signing UX

`shield` is the only kind that requires a user wallet signature. The "Confirm in your wallet" copy is surfaced by `stageCopy.ts` when `executionState === 'waiting'` on the submit stage — `<TxLifecycleStepper>` (via `ProgressStep`) reads that automatically. No special handling here.

## What's wired now (Phase 2)

- The shield handler (`features/shield/handler.ts`) is registered with the executor; `tx.submit()` runs the full `build-proof → submit-relayer → hub-confirmed` chain. Direct-submit path: the user's wallet prompts once (the on-chain `PrivacyPool.shield(...)`, with a one-time USDC `approve(MAX_UINT256)` first if allowance is low). Gasless path: one prompt for the EIP-2612 USDC permit. `shieldPrivateKey` is generated locally (random 32 bytes) at build-proof — no signing prompt for the Railgun-convention message; see `lib/shielded/shield.ts` for why randomness is correct.
- `useUsdcBalances()` polls the connected wallet's hub USDC balance into `usdcBalancesAtom` so the MAX is populated.
- After confirmation the handler triggers `refreshShieldedBalances`, which fires the SDK's onBalanceUpdate callback and `useShieldedBalanceSync` writes the new shielded total into `shieldedUsdcAtom`.

## What's also wired

- **Fees are live.** `ShieldModal` uses `useFees({ chainId })` (`quote` / `isStale` / `refresh()`); the gasless path reads `quote.fees.shield` / `quote.fees.shieldXchain` and submits a `feeCacheId`. Display flows through `useDisplayFees` + `computeFeeBreakdown` into the amount-card fee caption + breakdown tooltip.
- **Cross-chain shield is wired.** `computeKind()` dispatches `shield` vs `shield-xchain`; the `shield-xchain` handler (per-client gasless wrapper + CCTP fast-fee via `cctpFastFeeForAmount`) runs end-to-end.

## Still stubbed

_none_

## Why the modal lives at App level

`<ShieldModal />` is mounted once in `App.tsx` alongside the AppLayout outlet. Modal portal mounts to `document.body`, so opening Shield from any page (Dashboard / History / Settings) Just Works. The modal is invisible when `openModalAtom !== 'shield'`. Other feature modals (UnshieldModal, SendModal, YieldModal) will land at the same App level.
