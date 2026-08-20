# armada-interface — UI Plan

**Status:** Plan agreed. Implementation not started.
**Companion to:** `PLAN_ARMADA_INTERFACE.md` (workspace + tx lifecycle architecture, locked).
**Scope:** Visual + interaction design for Dashboard / History / Settings + the four primary action flows. Onboarding (first-run / unlock) included as a top-level guard.

This plan adapts a UX direction proposed by an external model. Where that direction conflicts with our existing primitives, tx-lifecycle model, or locked decisions, our model wins.

## 1. UX direction (kept)

The app should feel like **a focused private USDC account**, not a crypto control panel. Calm, stable, transaction-safe. The dashboard answers three questions at a glance:

- How much private USDC do I have?
- What is happening right now?
- What can I safely do next?

Protocol detail is progressively disclosed — never the headline.

## 2. App shell (already built — do not rebuild)

`AppLayout.tsx` is final. Fixed inset header: `ArmadaLogo` (left) · `NavBar` with `Dashboard · History · Settings` (centered) · `WalletConnector` → `WalletButton` (right). No status pill, no privacy-state indicator, no extra chrome. Body is centered, `pt-20` clears the header.

If wallet/network is locked or uninitialized, a **top-level guard** in `App.tsx` swaps the route outlet for the onboarding/unlock flow (see §8). This blocks Dashboard, History, and Settings together — they all surface identity-bound data.

## 3. Dashboard

```
┌──────────────────────────────────────────────┐
│ BalanceHero                                  │
└──────────────────────────────────────────────┘
┌────────────┬────────────┬────────────┬───────┐
│ Deposit    │ Withdraw   │ Send       │ Earn  │
└────────────┴────────────┴────────────┴───────┘
┌────────────────────────┬─────────────────────┐
│ RecentActivityCard     │ InProgressCard      │
└────────────────────────┴─────────────────────┘
```

Desktop: 12-col grid; hero full width; ActionGrid full width (4 equal cards); lower row 7/5 split. Mobile: stacked vertically; ActionGrid becomes 2x2.

### BalanceHero

| Field | Source | Display |
|---|---|---|
| Total private balance | `shieldedUsdcAtom` + `yieldShares` × current rate | Largest type; the visual anchor |
| Available privately | `shieldedUsdcAtom` | Secondary |
| Earning in vault | `yieldShares` × current rate | Secondary |

Explicitly **not shown**: USD conversion, public wallet balances, chain badges, APY, token list, connected address (already in the wallet pill).

Optional decorative element on the right side of the card — subtle, brand-derived (e.g. a faded ring/loop motif). Don't lock the exact asset; flag for the designer when one is in the room.

Below the card, a single dim line of microcopy spanning the dashboard footer: "Your privacy is protected. All transactions are shielded." Small, low-emphasis, always-on.

When `shieldedUsdcAtom === null` or `yieldShares === null` (sync not finished): show a "Syncing private balance…" state with skeleton numerals — do not show `0`.

### ActionGrid

Four equal `ActionCard`s, each with icon + title + one-line subtitle. Click opens the modal flow via `setOpenModal(...)`.

| Card | Subtitle | Modal | Kind(s) chosen inside |
|---|---|---|---|
| Deposit | Move USDC into private balance | `shield` | `shield` (with `fromChainId` selector) |
| Withdraw | Send to your wallet | `unshield` | `unshield-local` if dest=hub, else `unshield-xchain` |
| Send | Pay privately or to a wallet | `payment` | Private tab → `transfer-shielded`; External tab → `unshield-local` (hub recipient) or `payment-xchain` (xchain recipient) |
| Earn | Move into the savings vault | `yield-deposit` / `yield-withdraw` (Earn modal has two tabs that drive `openModalAtom` accordingly) | `yield-deposit` or `yield-withdraw` |

### RecentActivityCard

Reads `txListAtom`, filters to terminal states (`completed | failed | expired | cancelled`), sorts by `updatedAt` desc, shows up to 5 rows. Each row uses `TxRow` (compact). Click → opens a read-only detail drawer/modal anchored to the same record id used in History. Empty state: `EmptyState` with "Your recent activity will appear here."

### InProgressCard

Reads `pendingTxsAtom` (the non-terminal derived atom). One row per record — multiple concurrent withdraws each render their own row (you confirmed). Each row: human-readable title (e.g. "Withdraw to Base") + current-stage copy ("Waiting for confirmation") + a `BarTrackTicks` progress strip (`stagesCompleted.length / lifecycle.stages.length`). Click → expand inline to a full `TxLifecycleStepper`. Empty state: nothing visible (collapse to a thin "All quiet" state, or hide the card entirely — TBD when we wire it).

## 4. Modal flows

All four action flows use the same shell. No routes, no URL changes. Multiple flows cannot be open simultaneously — `openModalAtom` is a single slot. Per Plan §7, multiple **in-flight tx records** can coexist (each its own `useTx({kind})` instance), but the user only sees one at a time.

### ActionFlowShell

A single component, config-driven. Visual reference: the designer's committer mockup (Wallet → Commit → Review → Approve → Confirmation panels). We're adopting that visual grammar — wide-ish horizontal card, ticked step indicator at top, large centered content, primary + secondary CTA pair at the bottom.

```
┌──────────────────────────────────────────────────┐
│ FlowHeader: title / close            STEP 2 OF 4 │
│ <BarTrackTicks> step indicator                   │
├──────────────────────────────────────────────────┤
│ FlowBody: <step component>                       │
│   step ∈ { input, review, progress,              │
│            complete, error }                     │
├──────────────────────────────────────────────────┤
│ FlowFooter: secondary (Back / Cancel) | primary  │
└──────────────────────────────────────────────────┘
```

Each feature provides three child renderers: `<InputStep>`, `<ReviewStep>`, `<CompleteStep>`. Two steps are shared across all features:
- `<ProgressStep>`: wraps `<TxLifecycleStepper record={record}/>` fed by `useTx`.
- `<ErrorStep>`: error icon + headline + supporting message (from `record.artifacts.error` or the throw site) + Try Again + View Details CTAs. Try Again calls `useTx.retry()` if the failing stage is in `lifecycle.retryableStages`; else returns to Input with the form pre-filled.

**Wallet-signing sub-state**: only `shield` requires a wallet signature (it's the only user-submitted kind — all other kinds go through the relayer per `relayer/modules/privacy-relay.ts`). We do **not** model this as a separate flow step. Instead, when the shield executor calls `signer.sendTransaction(...)` it sets `record.executionState = 'waiting'`. The `<TxLifecycleStepper>` reads that and renders "Confirm in your wallet" as the active stage's copy. Once the wallet provider resolves the signature, the executor flips back to `'active'` and the stage copy advances. Same machinery the xchain Iris-attestation wait already uses — just different copy keyed off `(stage, executionState)`.

Stage copy resolution becomes `stageCopy(kind, stage, executionState?)` so the same stage can render different strings while waiting vs while active. Default fallback if `executionState` is omitted: the active-stage copy.

Step indicator: `BarTrackTicks` at the top of every step. Step count = number of `ActionFlowShell` steps for this flow (input/review/progress/complete — error is overlaid, not counted). The active tick advances with each shell transition. Same primitive the committer uses — no new component.

Shell behavior:
- Desktop: centered modal, target ~620px wide (revisit when the designer ships an explicit modal width token).
- Mobile: bottom sheet, ~95vh.
- Swipe-/escape-dismiss is **disabled during `progress`** (active executor work in flight; this covers wallet-signing too since it's a sub-state of progress).
- Closing a modal during `progress` leaves the record running in the background; it shows up in InProgressCard. If `executionState === 'waiting'` for a wallet signature, the modal's close handler shows a soft confirm: "Cancel the pending wallet prompt to close this window."

### Shield (Deposit)

| Step | Fields |
|---|---|
| input | `ChainSelect` (from chain — hub / clientA / clientB) · `AmountInput` rendered as a big serif display number with `AVAILABLE` and `MAX` labels beneath (committer-mockup style), reading `useBalances().unshielded[chainId]`, with a Max button · `FeeSummary` |
| review | Read-only echo of input + final fee + "You'll deposit X USDC" |
| progress | `<TxLifecycleStepper>` for `shield` (3 stages). **Shield is the only kind that surfaces a wallet sign** — handled as `executionState === 'waiting'` on the `submit-tx` stage with copy "Confirm in your wallet". Also: requires a prior USDC approve (its own wallet pop) unless we wire EIP-2612 permit. Approve handling lives in `lib/railgun/wallet.ts` or a new `lib/shield.ts` helper; flow stays the same. |
| complete | Celebratory "You're in." style headline + "Your private balance is now Y USDC." + "View activity" + "Done" CTAs |

### Unshield (Withdraw)

| Step | Fields |
|---|---|
| input | `ChainSelect` (destination — hub / clients) · recipient defaults to connected EVM address (editable, but framed as "send to my wallet"; switching to a different address is the same as "send to external wallet" — accepted) · `AmountInput` (big display) reading `shieldedUsdcAtom` · `FeeSummary` |
| review | Same shape · explicit destination chain · explicit recipient |
| progress | `<TxLifecycleStepper>` for `unshield-local` (3 stages) or `unshield-xchain` (7 stages) — relayer-submitted, no wallet pop |
| complete | "Withdrawn X USDC to <recipient> on <chain>" |

### Send

| Step | Fields |
|---|---|
| input | Tabs: **Private (0zk)** / **External wallet**. Private: `RecipientInput` (validates `0zk…`) · `AmountInput` (big display). External: `ChainSelect` · `RecipientInput` (validates `0x…`) · `AmountInput`. `FeeSummary` in both. |
| review | Same shape, with the resolved kind labelled clearly |
| progress | stepper for `transfer-shielded` / `unshield-local` / `payment-xchain` as appropriate — relayer-submitted, no wallet pop |
| complete | "Sent X USDC to <recipient>" |

### Earn

| Step | Fields |
|---|---|
| input | Tabs: **Add funds** (deposit into vault) / **Withdraw** (redeem shares back to shielded USDC). Each tab has `AmountInput` (big display) reading the relevant balance. Show a **computed APY** under the input — derived from `useYieldRate()`. Annotate "Estimated APY, based on recent vault rate" so it's clear this is not a promise. |
| review | Same shape · echo APY value used for the quote |
| progress | stepper for `yield-deposit` / `yield-withdraw` (3 stages each) — relayer-submitted, no wallet pop |
| complete | "Earning balance: Y USDC" |

APY computation lives in a `lib/yield.ts` helper (new). It compounds the per-block / per-second rate into an annualized figure with explicit decimals. We log the source rate + the annualized value via telemetry so we can audit drift later.

## 5. Tx lifecycle UI

`<TxLifecycleStepper record={record}/>` is the single renderer for any kind. It reads `lifecycleFor(record.kind)` and `record.stage` / `record.stagesCompleted` / `record.executionState` and emits a vertical stepper with:

- One row per stage in `lifecycle.stages`
- Status mark per row: done / current / pending / failed
- Current row shows ETA: a relative time computed from `lifecycle.estDuration` and `record.updatedAt`
- Top-level `StatusChip` reflecting `executionState`
- A `TechnicalDetailsDisclosure` at the bottom revealing `record.artifacts` (tx hashes, attestation hash, dest tx hash, error string) with explorer links built from `config/network.ts`

Stage copy lives in one file (`components/tx/stageCopy.ts`). It accepts an optional `executionState` so the same stage can render different copy while waiting vs while active (e.g. shield's submit stage shows "Confirm in your wallet" while `'waiting'`, then "Submitting transaction" while `'active'`):

```ts
const COPY: Record<TxKind, Partial<Record<string, string | { active: string; waiting: string }>>> = {
  shield: {
    'build-proof': 'Preparing transaction',
    'submit-relayer': { waiting: 'Confirm in your wallet', active: 'Submitting transaction' },
    'hub-confirmed': 'Deposited',
  },
  'unshield-xchain': {
    'build-proof': 'Preparing transaction',
    'submit-relayer': 'Submitting privately',
    'hub-burn-confirmed': 'Confirmed on hub',
    'iris-attestation-pending': 'Waiting for cross-chain confirmation',
    'iris-attestation-ready': 'Cross-chain confirmation ready',
    'client-mint-pending': 'Delivering on destination chain',
    'client-mint-confirmed': 'Funds delivered',
  },
  // …
}
```

Never expose raw stage names in the primary UX. They remain visible inside the technical-details disclosure for debugging.

## 6. Activity page (`/history`)

Layout: a `<SectionHeader>` ("Activity") + filter chip row (All / Pending / Complete / Failed — chips toggle visibility) + a list of `TxRow`s. Click a row to expand `<TxLifecycleStepper>` inline beneath it (no navigation). Pagination deferred — show up to N most recent (configurable), no infinite scroll for v1.

`TxRow` displays:
- Human title from `stageCopy(kind)` (e.g. "Withdraw to Base", "Private transfer", "Vault deposit")
- Amount (USDC formatted)
- Relative timestamp
- `StatusChip` (Pending / Complete / Failed / Expired / Cancelled)

Explicitly **not** in the row: tx hashes, raw stage strings, addresses.

## 7. Settings page (`/settings`)

Three small sections. Each section is a `Card` with a `SectionHeader`.

| Section | Contents |
|---|---|
| Private Wallet | "Lock now" button · "Export recovery phrase" (gated by re-entering passphrase) · "Reset private wallet" (destructive, double-confirm) |
| Preferences | Auto-lock timer (5/15/30 min) · Reduced motion is OS-driven via `<MotionConfig reducedMotion="user">` — no toggle here |
| Advanced | Network (read-only display of `VITE_NETWORK`) · App version · "Show technical details by default" toggle (defaults off — flips the default state of `TechnicalDetailsDisclosure` across the app) |

Explicitly **not** included: RPC status panels, relayer health panels, indexer health panels, currency display toggle, public wallet asset listing.

If infra is broken, surface it inline in the affected flow (e.g. relayer unreachable → submit step shows the error and a retry; do not lard the Settings page with always-on diagnostic widgets).

## 8. First-run / unlock (top-level guard)

`App.tsx` reads `shieldedWalletAtom.state`:

| State | Behavior |
|---|---|
| `uninitialized` | Render `<OnboardingFlow>` instead of route outlet |
| `locked` | Render `<UnlockFlow>` instead of route outlet |
| `unlocked` | Render the route outlet (Dashboard / History / Settings as usual) |

### OnboardingFlow (first run)

A sequential, calm, multi-step in-page flow (not a modal — there's nothing behind it). Each step is its own pane within an `<ActionFlowShell>`-shaped container — same primitives, no modal chrome.

1. **Welcome.** "Create your private USDC account." Single CTA: Create.
2. **Generate mnemonic.** Show the 12-word recovery phrase. "Copy" + "I've saved it" CTA. No "skip".
3. **Confirm phrase.** Three-word fill-in (e.g. "Type word 3, 7, and 11"). On miss, allow retry without regenerating.
4. **Set passphrase.** Enter + confirm. PBKDF2 (≥100k iters) per Plan §9. Brief copy explaining "this encrypts your phrase on this device — we cannot recover it."
5. **Done.** "Your private account is ready." CTA returns to Dashboard.

### UnlockFlow (returning user)

Single screen: passphrase input + Unlock CTA. On failure: gentle error, no lockout in v1. After N failures we can add backoff (TODO marker; not implemented now).

## 9. Reusable components (new)

App-local primitives under `components/ui/`. **Not** promoted to `@armada/ui` until they're stable and a second consumer wants them.

| Component | Purpose | Used by |
|---|---|---|
| `Card` | Surface (bg, radius, padding) | BalanceHero, ActionCard, RecentActivityCard, InProgressCard, Settings sections, Modal body |
| `Modal` | Backdrop + centered/sheet shell + close handling + focus trap | All action flows |
| `ActionFlowShell` | input/review/progress/complete/error state machine + shared header (incl. `BarTrackTicks` step indicator) + footer. Wallet-signing is a sub-state of `progress`, not a peer step. | All action flows + onboarding (same shell, different chrome wrapper) |
| `AmountInput` | USDC-decimal-aware input. Supports a **big display variant** (large serif numeral with `AVAILABLE` / `MAX` labels — committer-mockup style) and a **compact variant** (standard input). Max button, validates against a balance. | All flows |
| `RecipientInput` | Auto-detects `0zk…` vs `0x…`, validates format | Unshield, Send |
| `ChainSelect` | Dropdown over `network.ts` hub + clients | Shield, Unshield, Send |
| `FeeSummary` | "Estimated fee · You'll receive" | All flows |
| `StatusChip` | Pending / Complete / Failed / Expired / Cancelled visual | RecentActivity, History, InProgress, ProgressStep |
| `EmptyState` | Centered icon + copy | RecentActivity, History (filtered empty) |
| `SectionHeader` | Heading + optional trailing slot | Settings, History, Dashboard sub-sections |
| `TechnicalDetailsDisclosure` | Collapsible details for `artifacts` | TxLifecycleStepper |
| `DisplayNumber` (deferred) | Charis-SIL display numeral with currency suffix + caption slot. Codify after 2-3 inline uses. | BalanceHero, AmountInput big variant |

Feature components (existing folders):

| Folder | New components |
|---|---|
| `components/balance/` | `BalanceHero` (`BreakdownChip` already planned) |
| `components/dashboard/` (NEW) | `ActionGrid`, `ActionCard`, `RecentActivityCard`, `InProgressCard` |
| `components/tx/` | `TxLifecycleStepper`, `TxRow`, `TxStatusChip` (wraps `StatusChip`), `stageCopy.ts` |
| `components/flow/` (NEW) | `ActionFlowShell`, `FlowHeader` (incl. ticked step indicator), `FlowFooter`, `ProgressStep`, `ErrorStep` |
| `components/onboarding/` (NEW) | `OnboardingFlow`, `UnlockFlow`, mnemonic display + confirm-words steps |
| `components/shield/` | `ShieldModal`, `ShieldInputStep`, `ShieldReviewStep`, `ShieldCompleteStep` |
| `components/unshield/` | `UnshieldModal` + its three step components |
| `components/payments/` | `SendModal` + step components (with the Private/External tabs) |
| `components/yield/` | `YieldModal` + step components (with the Add/Withdraw tabs) |
| `components/settings/` | `PassphraseDialog`, `MnemonicExport`, `ResetWallet`, `AutoLockTimerControl` |

Existing `@armada/ui` primitives we reuse as-is: `Button`, `Progress` + `BarTrackTicks` (stepper bars), `Tag` (informational chips where `StatusChip` is overkill), `NavBar`, `WalletButton`, `ArmadaLogo`.

## 10. Visual rules

Reference: `/.context/attachments/Screenshot 2026-05-19 at 9.52.11 AM.png` (designer's committer mockup) is the **target visual style** for modal flows, adapted to our content. The GPT mockups are only directional.

- **Spacing & color**: drive from `@armada/ui` tokens (`--semantic-*`). No raw hex, no Tailwind typography classes, ever.
- **Typography**: body baseline only. Display type — balance hero numeral, big amount input, "You're in." style success headline — uses inline `style` with `fontFamily: 'Charis SIL, serif'` + numeric size — match the existing Dashboard placeholder pattern. After we use it 2-3 times, codify a `<DisplayNumber>` primitive (open item).
- **Step indicator**: `BarTrackTicks` from `@armada/ui` at the top of every flow step pane. "STEP N OF M" microcopy aligned right. Already in our token system.
- **Surfaces**: dark neutral background (`--semantic-color-surface-bg`), raised cards on `--semantic-color-surface-default` / `-raised`. Borders are `--semantic-color-border-default` (very low alpha). Differentiate cards via background lift, not stroke.
- **Buttons**: primary purple (`Button variant="primary"`) for forward actions; ghost / secondary for Back / Cancel. Pill radius (already in tokens via `--semantic-borderRadius-button`).
- **Status accents**: success = `--semantic-color-status-success`; error = `--semantic-color-status-error`; pending/active = brand lavender.
- **Motion**: fade + slight slide only. Respect `prefers-reduced-motion` (already handled by `<MotionConfig reducedMotion="user">`).
- **Footer microcopy**: dim, small, sparing. Use it for trust cues like the dashboard "Your privacy is protected" line, not for general help text.

## 11. State integration cheat sheet

| UI surface | Reads | Writes |
|---|---|---|
| BalanceHero | `shieldedUsdcAtom`, `yieldSharesAtom`, `useYieldRate()` for share→USDC | — |
| ActionGrid | — | `openModalAtom` |
| RecentActivityCard | `txListAtom` (filtered terminal) | — |
| InProgressCard | `pendingTxsAtom` | — |
| ShieldModal | `useBalances().unshielded`, `useFees()`, `useTx({kind: 'shield'})` | tx record via `useTx.submit()` |
| UnshieldModal | `shieldedUsdcAtom`, `useFees()`, `useTx({kind})` | tx record |
| SendModal | `shieldedUsdcAtom`, `useFees()`, `useTx({kind})` | tx record |
| YieldModal | `shieldedUsdcAtom`, `yieldSharesAtom`, `useYieldRate()`, `useFees()`, `useTx({kind})` | tx record |
| Activity (`/history`) | `txListAtom` (+ filters in local state) | — |
| Settings | `shieldedWalletAtom`, preferences atom (NEW — `state/preferences.ts`) | preferences writes |
| OnboardingFlow / UnlockFlow | `shieldedWalletAtom` | `shieldedWalletAtom` (create/unlock/lock via hooks) |

New atom: `preferencesAtom` in `state/preferences.ts` — `{ autoLockMinutes, showTechnicalDetailsByDefault }`. Persisted to IDB.

## 12. Out of scope / deferred

- Mobile-specific layout polish beyond stacking + bottom-sheet modals.
- Address book.
- Mnemonic **import** flow (only generate-on-first-run — Plan §15.7).
- ENS resolution for recipients.
- Multi-wallet support inside the UI (Plan §21).
- Toasts for tx state changes — toasts only for explicit errors that can't be surfaced inline. `<ArmadaToaster>` from the provider tree is kept for that.
- Hardware-wallet UX above what wagmi gives us.

## 13. Implementation order (proposed)

1. **`components/ui/` primitives**: `Card`, `Modal`, `EmptyState`, `SectionHeader`, `StatusChip`, `TechnicalDetailsDisclosure`. Pure visuals, no data.
2. **`components/flow/`**: `ActionFlowShell` + `ProgressStep` + `ErrorStep`. Wire it against a fixture record so we can iterate without real submits.
3. **`components/tx/`**: `TxLifecycleStepper`, `TxRow`, `stageCopy.ts`. Drives both InProgress and Activity rendering.
4. **`components/balance/BalanceHero`** + Dashboard layout (`ActionGrid`, `ActionCard`, `RecentActivityCard`, `InProgressCard`). Stub action cards open the modal with the current empty modal shell.
5. **Onboarding + unlock guard** in `App.tsx`. Stub mnemonic generation against the existing `lib/railgun/wallet.ts` stub; only wire the UI flow.
6. **Shield modal end-to-end** (still against the stubbed lib). Validates that `useTx` + executor + stepper all surface correctly.
7. **Unshield modal**, then **Send modal**, then **Earn modal** — each in its own PR.
8. **Activity page** with filters.
9. **Settings page** (lock now, export, reset, auto-lock).

Each step is independently mergeable. Real lib integrations land separately per the parent plan's feature passes.

## 14. Open items to revisit

- `<DisplayNumber>` primitive: codify the Charis-SIL display-type pattern after we use it 2-3 times.
- APY precision + label phrasing — once `useYieldRate()` is real, audit the displayed number with someone who'll use it.
- Empty-state copy and illustration choices — get a pass from the designer when one is in the room.
- Bottom-sheet swipe-dismiss behavior on mobile during non-`progress` steps — UX call we can defer until we actually have a mobile testing rig.
- Recovery-phrase confirm UX — 3-word fill-in is locked, but the exact word positions (always 3/7/11 vs random) is a small detail to nail before shipping.
