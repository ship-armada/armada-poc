# components/ui/

App-local UI primitives. Layered **above** the vendored design system in `src/design` (imported as `@/design` — Button, Text, NavBar, WalletButton, WalletPillMenu, ArmadaLogo, ArmadaSymbol) and **below** feature components (BalanceHero, ShieldModal, etc.).

These primitives are NOT in `src/design` because they aren't yet stable enough to fold into the design layer. Move a primitive into `src/design` once its shape is settled.

## Current contents

| Primitive | Purpose |
|---|---|
| `AmountInput` | USDC amount input. `display` variant (big serif numeral) and `compact` variant. MAX button + AVAILABLE caption when `max` is supplied. |
| `Card` | Surface — bordered, rounded, padded body. `default` and `raised` variants. |
| `ChainSelect` | Native `<select>` dropdown over `getAllChainIdentities()`; restrict via `chains` prop. |
| `EmptyState` | Centered icon + title + optional description + optional action. |
| `FeeSummary` | Two-row "Estimated fee" + "You'll receive" panel. Loading state when `fee === null`. |
| `Modal` | Centered modal with backdrop, focus trap, ESC dismissal, portal mount. (See Modal/) |
| `RecipientInput` | Labelled address input with optional Paste-from-clipboard shortcut + inline error. Validation lives in `lib/address`. |
| `SectionHeader` | Heading with optional trailing slot (link, chip, action). |
| `StatusChip` | Color-coded status pill. Variants: `neutral`, `info`, `success`, `warning`, `error`. |
| `Tabs` | Horizontal segmented control with ARIA tablist semantics. Generic over a string-id union. |
| `TechnicalDetailsDisclosure` | Collapsible "Show technical details" wrapper built on native `<details>`. |

## Conventions (mirror `src/design`)

- Folder per primitive: `Primitive/Primitive.tsx` + `Primitive.module.css` + `index.ts`.
- ABOUTME header on every file (two lines).
- CSS Modules reference `var(--semantic-*)` tokens from `src/design/styles/tokens.css`; never hardcode hex/px.
- No `clsx`, `classnames`, or `cva` — use the manual `[...].filter(Boolean).join(' ')` pattern.
- No typography Tailwind classes in the `.tsx`. Tailwind is allowed for layout (`flex`, `gap`, `mx-auto`) but text size / weight / letter-spacing / line-height come from CSS Modules.
- Each primitive ships a co-located `.test.tsx` file. Tests use `@testing-library/react`; we don't have `user-event` installed, so use `fireEvent` for interaction tests.

## When to fold into `src/design`

`src/design` is the app's own vendored design layer (severed from the shared `@armada/ui` so the app is self-contained ahead of its repo spin-out). Fold a primitive into `src/design` once its shape has been stable for at least one feature pass. Until then, keep it here — premature promotion makes the design layer harder to change.
