# components/shield/

The deposit (public → private) flow. Owned by `ShieldModal`, opened via `setOpenModal('shield')`.

## Contents

| Component | Purpose |
|---|---|
| `ShieldModal` | Orchestrator. Owns `step` + form state, wires `useTx({kind:'shield'})`, renders ActionFlowShell. |
| `ShieldInputStep` | From-chain `ChainSelect` + `AmountInput` (display variant) + `FeeSummary`. Validates amount > 0 and ≤ max. |
| `ShieldReviewStep` | Read-only echo with the big-numeral amount + From chain row + FeeSummary + Confirm CTA. |
| `ShieldCompleteStep` | Success panel ("Success — you've deposited X USDC") + Done CTA. |

## State machinery

- `openModalAtom === 'shield'` controls visibility.
- Step state is local to `ShieldModal` — `'input' → 'review' → 'progress' → 'complete'` (or `'error'`).
- Form state (`fromChainId`, `amountStr`) is reset when the modal closes.
- `useTx({kind:'shield'}).submit(meta)` creates the record + dispatches the executor.

## Wallet-signing UX

`shield` is the only kind that requires a user wallet signature. The "Confirm in your wallet" copy is surfaced by `stageCopy.ts` when `executionState === 'waiting'` on the submit stage — `<TxLifecycleStepper>` (via `ProgressStep`) reads that automatically. No special handling here.

## What's wired now (Phase 2)

- The shield handler (`features/shield/handler.ts`) is registered with the executor; `tx.submit()` runs the full `build-proof → submit-relayer → hub-confirmed` chain. Direct-submit path: the user's wallet prompts once (the on-chain `PrivacyPool.shield(...)`, with a one-time USDC `approve(MAX_UINT256)` first if allowance is low). Gasless path: one prompt for the EIP-2612 USDC permit. `shieldPrivateKey` is generated locally (random 32 bytes) at build-proof — no signing prompt for the Railgun-convention message; see `lib/railgun/shield.ts` for why randomness is correct.
- `useUsdcBalances()` polls the connected wallet's hub USDC balance into `usdcBalancesAtom` so the MAX is populated.
- After confirmation the handler triggers `refreshShieldedBalances`, which fires the SDK's onBalanceUpdate callback and `useShieldedBalanceSync` writes the new shielded total into `shieldedUsdcAtom`.

## Still stubbed

- `useFees()` returns `quote=null`; FeeSummary renders "Loading…". Direct hub shield has no relayer fee today, so this is cosmetic — the handler doesn't read fees.
- Cross-chain shield (from client chain via CCTP) — different contract surface; will land in its own commit.

## Why the modal lives at App level

`<ShieldModal />` is mounted once in `App.tsx` alongside the AppLayout outlet. Modal portal mounts to `document.body`, so opening Shield from any page (Dashboard / History / Settings) Just Works. The modal is invisible when `openModalAtom !== 'shield'`. Other feature modals (UnshieldModal, SendModal, YieldModal) will land at the same App level.
