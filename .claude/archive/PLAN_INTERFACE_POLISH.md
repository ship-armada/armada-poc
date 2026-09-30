# Interface — Designer Polish Update (apply plan)

## Source
Designer polish pulled into the mockup clone `.context/armada-app`.
Diff range: **`cec8936..8dc3e28`** (2 commits on 2026-08-18):
- `000e1b8` Polish dashboard, modal, and pay-via-link UI to one motion and layout system.
- `8dc3e28` Roll dashboard balances after the tx modal closes.

`cec8936` is the clone baseline all our prior redesign PRs (#478–#486) were built against, so this range is exactly "what's new since we started."

127 files changed. Re-diff any file with:
`git -C .context/armada-app diff cec8936 8dc3e28 -- <path>`

## Foundation (do FIRST — ripples everywhere)
- **`styles/tokens.css`**: new `--primitives-borderRadius-2xl` (16), `-3xl` (20); `--semantic-borderRadius-modal` now → `3xl`; new `--semantic-spacing-page-block` (spacing-24 + 1).
- **`styles/theme-overrides.css`**: new **frost scale** — `--semantic-color-frost` / `-frost-raised` / `-frost-hover` / `-frost-pressed` (white/neutral-50 over the gradient at 20/40/55/70%). `surface-main` now = `frost-raised`. Replaces one-off `color-mix(neutral-50 …%)` usages.
- Action: port both into `src/design/styles`, then sweep our merged components that used one-off color-mix / surface-main to adopt frost tokens where the mockup now does (e.g. header controls, gear hover).

## New components we don't have yet
- **`SegmentedControl`** — factored-out tab control (Earn Add/Withdraw currently inline in our EarnInputStep; likely adopt this).
- **`BalanceActionButton`** — dashboard balance action buttons (replaces IconButton usage on the card).
- **`TxProgressCard` + `TxProcessingLayout`** + `constants/txProcessingCopy.ts` / `txProcessingTiming.ts` — the in-flight/processing display we DEFERRED. Designer has now polished it.
- **`NumericKeypad`** — mobile keypad (we deferred mobile).
- **`DashboardScrollTopFade`**, hooks **`useFineHover`**, **`useHidePeek`**.
- **History**: `RecentActivityList/ActivityAllPanel` + `ActivityKindFilters` + `ActivityTxHashSearch` — the "View all" history surface (we haven't built History to the mockup yet).

## Changed components we HAVE ported (re-polish)
Shared primitives: `ModalShell` (+`ModalStepSwitch`, `modalExitMotion`), `FlowModalOverlay`, `SidePanel`, `IconButton`, `Tooltip`, `Button`, `SendButton`, `ArmadaLogo`, `BottomSheet`.
Dashboard: `BalanceCard`, `RecentActivityList`, `VaultPositionBar`, `DepositTooltip`, `ArmadaAppDashboard` (layout/motion), `DashboardCardStack`, `DashboardOverlays`.
Summaries: `DepositReviewSummary`, `EarnReviewSummary`, `SendReviewSummary`, `TransactionDateTimeRow`.
Amount: `AmountInputScreen`.

## Per-flow re-polish (flows already merged)
- **Dashboard** (#480): BalanceCard, RecentActivityList, VaultPositionBar, DepositTooltip, layout/motion, scroll-top fade, balances roll after modal close (`8dc3e28`).
- **Deposit** (#481): DepositAmountScreen, DepositReviewScreen(+css), DepositConfirmedScreen(+css), DepositModalFlow.
- **Send/Withdraw** (#482/#483): SendRecipientScreen(+css, big), SendReviewScreen(+css), SendConfirmedScreen(+css), Send/WithdrawModalFlow, sendFlowConstants.
- **Earn** (#484): EarnAmountScreen (css deleted → moved to SegmentedControl/AmountInputScreen), EarnReviewScreen, EarnConfirmedScreen, EarnModalFlow (big −157), EarnChooserSheet, earnFlowConstants.
- **Wallet panel** (#486): WalletMenuPanel(Ethereum/Shell), WalletPillMenu, WalletItem.

## New flows / areas not yet touched
- **History** (ActivityAllPanel + filters + hash search).
- **Processing / in-flight** (TxProgressCard / TxProcessingLayout) — previously deferred; now designer-polished.
- **Receive / Request / Pay-via-link** (RequestModalFlow, RequestLink/Details/Receive screens, PayViaLinkLanding, ReceivePayment* + their ReviewSummaries) — net-new flows.
- **NumericKeypad** / mobile — still deferrable.

## Proposed sequencing (PR-sized)
1. **Foundation**: tokens + frost scale + sweep merged components to frost. (small, unblocks the rest)
2. **Shared primitives**: ModalShell/FlowModalOverlay/SidePanel/IconButton/Tooltip/Button/SendButton/ArmadaLogo/BottomSheet + new SegmentedControl + BalanceActionButton.
3. **Dashboard re-polish** (incl. balances-roll-after-close, scroll fade).
4. **Deposit + Send/Withdraw + Earn re-polish** (per flow; Earn adopts SegmentedControl).
5. **Wallet panel re-polish**.
6. **History** (new).
7. **Processing/in-flight** (new; was deferred).
8. **Receive/Request/Pay-via-link** (new).
9. Mobile keypad (optional/deferred).

## Open decisions
- Adopt `SegmentedControl` to replace our inline Earn tabs? (recommend yes)
- Tackle the deferred Processing display now that it's polished, or keep after the merged-flow re-polish? (recommend after re-polish, as its own PR)
- Batch vs per-flow PRs — foundation must be its own first PR; the rest can be per-flow.
