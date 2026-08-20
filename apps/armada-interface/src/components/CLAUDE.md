# components/

UI components. **Dumb when possible.** State comes from hooks + atoms; effects belong in hooks.

## Hard rules

- **No `ethers` imports.** If you need to call a contract, write a hook.
- **No `@railgun-community/*` imports.** Same reason.
- **No `useEffect` with side effects beyond DOM concerns.** If you find yourself fetching/polling/timing in a component, move the logic to a hook.
- **No typography Tailwind classes.** `text-xs`/`font-medium`/`tracking-*`/`leading-*`/`uppercase` are forbidden. Use the body baseline (15 px Geist 1.5) or a `@/design` primitive that owns its own typography.
- **Layout Tailwind classes are fine.** `flex`, `grid`, `mx-auto`, `pt-20`, color tokens (`text-foreground`, `bg-card`) — those are layout/color, not typography.

## Current contents

| File / dir | Purpose |
|---|---|
| `AppLayout.tsx` | Fixed-inset header + nav + body wrap |
| `AppErrorBoundary.tsx` | Top-level error boundary (outside the providers) — a render error anywhere surfaces a recoverable card instead of a white screen; funnels to Sentry via telemetry |
| `WalletConnector.tsx` | Header wallet button — RainbowKit render-prop wired to the `@/design` `WalletButton` (all 4 states) |
| `WalletMenu/` | Wallet side-panel (pill → slide-out) — balance, address, hide toggle, actions; the redesigned wallet surface |
| `RelayerStatusBanner/` | Banner shown when the relayer is unreachable / degraded |
| `ui/` | App-local primitives (Card, Modal, AmountInput, ChainSelect, FeeSummary, RecipientInput, SectionHeader, StatusChip, Tabs, TechnicalDetailsDisclosure, EmptyState, SegmentedControl, Tooltip, FeeBreakdownTooltip, EstimatedFeeValue, GasBalanceNotice, WalletProviderIcon) — see `ui/CLAUDE.md` |
| `flow/` | `FlowShell` (the live modal chrome, wrapping vendored `FlowModalOverlay + ModalShell + ModalStepSwitch`) + `useFlowExit` + `ErrorStep` + `ProgressStep`. Legacy `ActionFlowShell`/`FlowHeader`/`FlowFooter`/`FlowStepIndicator` are retained-but-unused — see `flow/CLAUDE.md` |
| `deposit/` | Shared flow primitives — `DepositAmountCard` (amount + chain + fee caption + % pills), `DepositReviewSummary`, `DepositOverlayShell` — reused across shield/send/earn |
| `tx/` | TxLifecycleStepper, TxRow, TxStatusChip, TxActions, stageCopy helpers, `processing/` (TxProgressCard + timeline) — see `tx/CLAUDE.md` |
| `dashboard/` | BalanceCard + numerals + RecentActivityList (+ ActivityAllPanel / receipts) + DepositTooltip (centered card stack) — see `dashboard/CLAUDE.md` |
| `shield/` | ShieldModal + steps (deposit; same-chain + cross-chain) — see `shield/CLAUDE.md` |
| `payments/` | SendModal — the shared Send/Withdraw flow (variant-driven, address-picks-kind). Also seeds recipient/amount from a pay-via-link `paymentIntentAtom` on open — see `payments/CLAUDE.md` |
| `yield/` | EarnModal + steps (Add / Withdraw tabs) — see `yield/CLAUDE.md` |
| `receive/` | ReceiveDialog — plain 0zk address + copy (`openModalAtom='receive'`). Dormant: no entry point today (the Request flow is the dashboard's only receive affordance) |
| `request/` | RequestModal — the "Request USDC via link" flow (compose amount/expiry/note → generated link screen). Revoke is disabled ("coming soon"); the Link-revoked variant is built but unreachable until backend-backed revocation lands |
| `payViaLink/` | `PaymentLinkQrCode` — QR of a pay-via-link URL (`qrcode.react`). Shared by the payer landing (`pages/PayViaLinkLanding`) |
| `history/` | `HistoryRecoveryBanner` — chain-history-recovery status banner (mounted in AppLayout) |
| `sync/` | `SyncGate` + `SyncBanner` — initial shielded-balance sync gate + banner |
| `onboarding/` | `OnboardingFlowV2` (primary 4-step first-run: welcome → sign → checksum → complete) + `UnlockFlow` + `OnboardingLayout`/`OnboardingShell`; legacy 6-step `OnboardingFlow` retained — see `onboarding/CLAUDE.md` |
| `OnboardingLayout/` | Shell chrome for the onboarding/unlock screens |
| `settings/` | SettingsModal + RecoverySecretExportDialog, ResetWalletDialog, ClearHistoryDialog — see `settings/CLAUDE.md` |

## When you add a component

- Co-locate `.tsx` + `.module.css` if you need CSS Modules (mockup pattern).
- Add ABOUTME header.
- If the component needs data, take props. Don't reach into atoms inside a leaf component — pull at the page or modal level and prop-drill (or use a hook at the appropriate level).
- For modals, push open/close state into `openModalAtom` in `state/ui.ts`. The modal trigger button calls `setOpenModal('shield')`; the modal component reads `openModalAtom === 'shield'` to decide whether to render.
