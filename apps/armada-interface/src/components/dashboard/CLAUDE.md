# components/dashboard/

Dashboard presentation, ported from the armada-app design mockup. Composed by `pages/Dashboard.tsx` into a centered ~420px card stack (BalanceCard → DepositTooltip → RecentActivityList). Presentation only — all data/actions are wired in `Dashboard.tsx`.

## Contents

| Component / file | Purpose |
|---|---|
| `BalanceCard` | The "Private USDC" card: header (shield badge · label · eye/hide toggle), animated balance numeral, action row (SEND · `+` deposit · `↓` receive · `⋯` more menu = Earn/Withdraw/activity toggle), optional vault position bar. |
| `RollingBalanceValue` | Odometer roll for the balance numeral (intro from zero; re-roll from previous value on change). |
| `BalanceScrambleValue` | Steady-state hide/reveal scramble for the balance + activity amounts. |
| `VaultPositionBar` | Vault (yield) position row inside BalanceCard; shows earned + APR. |
| `SendButton`, `ShieldedUsdcBadge`, `TokenBadge` | Small presentational pieces of the card. |
| `DepositTooltip` | First-run "Make your first deposit" callout under the card (empty state). |
| `RecentActivityList` | Preview activity list — icon-badge rows with scrambled amounts; "View all" → `/history`. |
| `txActivityAdapter.ts` | Maps `TxRecord[]` → `DashboardActivityItem[]` (direction/sign/label/pending). The data seam for the activity list. |
| `dashboardFormat.ts` | Number-based `formatUsdcAmount` / `truncateArmadaAddress` / `formatTimeAgo` used by the ported (number-typed) components. Distinct from `@/lib/format` (bigint-based). |
| `vaultEarnings.ts` | `DEMO_EARN_APY` + vault-earning label/amount-format helpers used by VaultPositionBar. |

Shared primitives `IconButton`, `Tooltip`, `BottomSheet` live in `@/design`; the hooks (`useMobileLayout`, `useEscapeKey`, `useBodyScrollLock`, `useDashboardBackground`) live in `@/hooks`.

## Conventions

- **Presentation only.** These components take numbers/strings/callbacks; `Dashboard.tsx` reads the atoms/hooks and adapts. Don't reach into atoms here.
- **The mockup is the source of truth.** These are ports — restyle via tokens, keep motion parity; don't diverge from the mockup without a reason.
- Empty states are first-class (RecentActivityList renders "No activity yet"; the DepositTooltip is the balance-0 first-run affordance).

## Deviations from the vendored mockup

- `BalanceCard.module.css` `.armadaAddress` uses the sans UI font, not Geist Mono. The vendored mockup copy (cloned at the start of the redesign) specifies `mono-sm`, but the current designer mockup renders the shielded address in sans — the clone is likely stale. Re-cloning `.context/armada-app` may surface other drift.

## Known follow-ups

- `useDashboardBackground` is a stub returning `'gradient'`; the solid/gradient toggle UI is not ported.
- `↓` maps to Receive as a placeholder; a dedicated payment-request flow is planned.
- `VaultPositionBar` "earned" figure shows a literal `???` placeholder — real accrued yield needs vault cost-basis tracking (`sharesToUsdc(shares) − principal`), which isn't wired. Pass a real `earnedAmount` once that exists. Deliberately not a realistic-looking estimate, so the stub can't be mistaken for real data.
