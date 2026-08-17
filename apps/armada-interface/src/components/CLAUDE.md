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
| `AppLayout.tsx` | Fixed-inset header + nav + body wrap + global `AppFooter` |
| `AppFooter/` | Minimal global footer — centered Discord / X / homepage icon links (inline brand SVGs + lucide `Globe`); links configured in `SOCIAL_LINKS` |
| `WalletConnector.tsx` | Header wallet button — RainbowKit render-prop wired to the `@/design` `WalletButton` (all 4 states) |
| `ui/` | App-local primitives (Card, Modal, AmountInput, ChainSelect, FeeSummary, RecipientInput, SectionHeader, StatusChip, Tabs, TechnicalDetailsDisclosure, EmptyState) — see `ui/CLAUDE.md` |
| `flow/` | ActionFlowShell + FlowHeader + FlowFooter + FlowStepIndicator + ProgressStep + ErrorStep — see `flow/CLAUDE.md` |
| `tx/` | TxLifecycleStepper, TxRow, TxStatusChip, stageCopy helpers — see `tx/CLAUDE.md` |
| `dashboard/` | BalanceCard + numerals + RecentActivityList + DepositTooltip (centered card stack) — see `dashboard/CLAUDE.md` |
| `shield/` | ShieldModal + steps — see `shield/CLAUDE.md` |
| `payments/` | SendModal — the shared Send/Withdraw flow (variant-driven, address-picks-kind) — see `payments/CLAUDE.md` |
| `yield/` | EarnModal + steps (Add / Withdraw tabs) — see `yield/CLAUDE.md` |
| `onboarding/` | OnboardingFlow (5-step first-run), UnlockFlow, OnboardingShell — see `onboarding/CLAUDE.md` |
| `settings/` | RecoverySecretExportDialog, ResetWalletDialog — see `settings/CLAUDE.md` |

## When you add a component

- Co-locate `.tsx` + `.module.css` if you need CSS Modules (mockup pattern).
- Add ABOUTME header.
- If the component needs data, take props. Don't reach into atoms inside a leaf component — pull at the page or modal level and prop-drill (or use a hook at the appropriate level).
- For modals, push open/close state into `openModalAtom` in `state/ui.ts`. The modal trigger button calls `setOpenModal('shield')`; the modal component reads `openModalAtom === 'shield'` to decide whether to render.
