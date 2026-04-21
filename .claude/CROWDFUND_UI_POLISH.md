# Crowdfund UI Polish Plan

> **Status:** Planning doc — active. Archive to `.claude/archive/` when all phases are merged.
> **Scope:** Observer and Committer apps only. Admin app is internal-only and stays bare-bones.
> **Branch prefix:** `iskay/crowdfund-ui-*`

---

## 1. Purpose

Raise the crowdfund UI from utilitarian POC scaffolding to a polished, production-feeling experience. The visual identity (logo, brand colors, typography system) is **not yet finalized** — so this plan prioritizes building a **theme system and component foundation** that makes design-team handoffs cheap later, rather than committing to specific aesthetic choices now.

---

## 2. Decisions (fixed — do not re-litigate without user input)

| # | Decision | Implication |
|---|----------|-------------|
| D1 | **Dark mode only.** No light theme, no theme toggle. | Single set of CSS variables. Remove light-mode tokens and any `@custom-variant dark` / `next-themes` machinery. |
| D2 | **No brand identity yet.** Design team is still finalizing. | Use neutral, professional placeholder tokens (cool-gray + a single accent). Build the token *system* so values swap cleanly later. Don't overinvest in specific hues — they will change. |
| D3 | **Observer and Committer are siblings sharing a design system.** | Push the AppShell, theme CSS, and all UI primitives into `packages/shared/`. They should feel like the same product with different capabilities, not two different products. |
| D4 | **Spike `@xyflow/react` vs. iterate on d3** for the invite graph. | Run as a parallel half-day spike before committing to either path (see Phase 10). |
| D5 | **Keep existing dependencies where they already work.** | Jotai, ethers/viem, wagmi, RainbowKit, sonner, Radix, shadcn setup, tanstack-table, d3-hierarchy — all stay. We're wiring and composing, not replacing. |
| D6 | **No regression of functionality** during the polish pass. Every existing feature must still work at the end of each phase. | Do visual/UX work behind small PRs, not a single big rewrite. |

---

## 3. Background context for a fresh-context agent

### 3.1 What is the crowdfund?

Armada's crowdfund is a hub-chain Solidity mechanism where users commit USDC across three "hops" (social distance from an initial whitelist). Committers get ARM governance tokens when the crowdfund finalizes (or USDC refund if cancelled/undersubscribed). There is an invite-graph mechanic: each participant has a limited number of invite slots they can pass on to others, extending the graph outward one hop at a time.

### 3.2 The three frontend apps

Located under `crowdfund-ui/packages/`:

| App | Port (local) | Purpose | Wallet? | In scope? |
|---|---|---|---|---|
| `observer/` | 5173 | Read-only dashboard: invite graph, participant table, aggregate stats | No | ✅ Yes |
| `committer/` | 5174 | Wallet-connected participant UI: commit USDC, generate/redeem invites, claim ARM or refund | Yes (wagmi + RainbowKit) | ✅ Yes |
| `admin/` | 5175 | Internal admin controls (finalize, cancel, adjust caps) | Yes | ❌ No — intentionally minimal |

### 3.3 Monorepo structure (npm workspaces)

```
crowdfund-ui/
├── package.json              # workspace root
└── packages/
    ├── shared/               # ⭐ Shared TS library — source-only, no build step. main: "src/index.ts"
    │   └── src/
    │       ├── components/   # StatsBar, TreeView (d3), TableView, SearchBar, NodeDetail, TransactionFlow, ...
    │       ├── hooks/        # useContractEvents, useGraphState, useENS, useAllocations
    │       ├── lib/          # constants, event parsing, formatting, graph ops, tree layout, IndexedDB cache, RPC
    │       └── index.ts
    ├── observer/             # Vite app consuming @armada/crowdfund-shared
    │   └── src/              # App.tsx, main.tsx, index.css, hooks/, config/, lib/
    ├── committer/            # Vite app consuming @armada/crowdfund-shared + wallet libs
    │   └── src/              # App.tsx, main.tsx, index.css, hooks/ (wallet-specific), config/
    └── admin/                # out of scope
```

**Shared consumption pattern:** each app imports via workspace resolution, e.g.:
```ts
import { StatsBar, TreeView, useContractEvents } from '@armada/crowdfund-shared';
```
Because `shared` exports TS source directly (`main: src/index.ts`, no compile step), any change to shared is picked up by Vite's HMR instantly.

### 3.4 Current tech stack (verified, as of this doc's creation)

| Layer | Library | Version | Notes |
|---|---|---|---|
| Framework | React | 19.1.1 | |
| Bundler | Vite | via `@tailwindcss/vite` | |
| Styling | Tailwind CSS | v4.1.16 | CSS-first config, uses `@theme inline` block |
| Animations | tailwindcss-animate + tw-animate | — | CSS utilities only |
| State | Jotai | 2.15.1 | |
| Component system | shadcn/ui | **configured (`components.json`) but zero components installed** | Low-effort win: `npx shadcn add …` |
| Primitives | Radix | — | separator, slot, tooltip, dialog, label, select |
| Icons | lucide-react | 0.552.0 | |
| Toasts | sonner | 2.0.7 | **installed but never imported** |
| Tables | @tanstack/react-table | 8.21.3 | already used in TableView |
| Graph layout | d3-hierarchy + d3-force + d3-zoom + d3-scale + d3-transition | — | Used by `TreeView.tsx` |
| Caching | idb | 8.0.3 | IndexedDB wrapper for event cache |
| RPC (observer) | ethers | 6.15.0 | |
| RPC (committer) | viem + wagmi | 2.47.6 / 2.19.5 | + `@rainbow-me/rainbowkit` 2.2.10 |
| Routing (committer) | react-router-dom | 7.6.1 | for `/invite/:code` redemption URLs |

### 3.5 What's **missing** and will be added by this plan

- `framer-motion` — animations, micro-interactions
- `@tanstack/react-query` — retry, stale-while-revalidate, loading booleans
- `react-hook-form` + `zod` — form validation on commit/invite flows
- `@dicebear/core` + `@dicebear/collection` (or `react-blockies` / `@metamask/jazzicon`) — deterministic address identicons
- shadcn components (Button, Input, Card, Dialog, Badge, Skeleton, Tabs, Tooltip, Select, Alert, Popover, ScrollArea, Sheet, Separator, Label)

### 3.6 Current rough edges (verified in code)

1. **Duplicate CSS:** `observer/src/index.css` and `committer/src/index.css` both define theme tokens. Tokens are currently **light-themed** (`--background: oklch(0.9764 …)`).
2. **Hardcoded colors in TreeView:** `packages/shared/src/components/TreeView.tsx` has `HOP_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b']` and ~5 other hex literals. Not themed.
3. **Sonner installed but unused.** TransactionFlow uses manual state + conditional rendering instead of toasts.
4. **No shared Layout/Header/Footer component.** Each app's `App.tsx` hand-rolls its own header.
5. **Three different mobile tab bar implementations** across App.tsx, CommitTab, InviteTab.
6. **No skeleton loaders.** Just `animate-spin` circles or "Loading..." text.
7. **Error states inconsistent:** some inline red-bg divs, some disabled-reason text in tab centers.
8. **No retry logic** on ENS or RPC failures.
9. **Forms are ad-hoc:** commit amount input, invite count input — all controlled components with manual validation.
10. **No identicons / avatars** on graph nodes or table rows — every participant is a grey blob.

### 3.7 Do-not-touch list (from CLAUDE.md)

- `contracts/railgun/logic/` — adapted from Railgun, silently breaks ZK circuits if modified
- `_legacy/` — deprecated earlier approach
- `usdc-v2-frontend/` — residual Namada paths, being replaced
- Testing mode / verification bypass code — never enable
- `ArmadaYieldVault` intentional ERC-4626 deviations

None of these should be touched by this plan.

---

## 4. Plan — ordered phases

Each phase is a **separate PR** to `main`, branching off `iskay/crowdfund-ui-<phase>`. Each phase should end green: `npm run test` passes, both apps load and function.

### Phase 1 — Consolidate + dark-mode-only theme (foundation)

**Status:** ✅ Implemented on `iskay/crowdfund-ui-polish` (PR pending). Plan originally called for a dedicated `iskay/crowdfund-ui-theme` branch; bundled into the umbrella polish branch instead.
**Branch:** `iskay/crowdfund-ui-polish` (was planned: `iskay/crowdfund-ui-theme`)
**Effort:** ~0.5 day
**Why first:** every later phase consumes these tokens. No UI risk — purely infra.

**Actuals (as shipped):**
- Token file: `crowdfund-ui/packages/shared/src/styles/theme.css` — dark-only, placeholder values, comment flagging design-team swap point. Includes shadcn base + `--success/--error/--warning/--info` pairs + the domain tokens listed below.
- Domain tokens registered via `@theme inline` (all usable as Tailwind classes like `bg-hop-0`, `text-status-confirmed`): `--hop-0..2`, `--hop-root`, `--hop-multi`, `--hop-connected`, `--hop-selected`, `--hop-dimmed`, `--graph-edge`, `--graph-edge-active`, `--graph-edge-chain`, `--status-pending`, `--status-submitted`, `--status-confirmed`, `--status-failed`.
- `crowdfund-ui/packages/shared/package.json` — added `exports` map exposing `./styles/theme.css` (plus `.` and `./package.json`).
- Each app's `index.css` (observer, committer, **and admin** — included despite original scope doc listing only observer/committer, since admin's CSS was byte-identical and would have drifted) slimmed from 127 lines to 10: tailwind import + @source + @plugin/@import animate + `@import "@armada/crowdfund-shared/styles/theme.css"`. Removed `@custom-variant dark`, `.dark` block, light-mode `:root`, `color-scheme: light dark`.
- `crowdfund-ui/packages/shared/src/components/TreeView.tsx` — all 13 hex literals replaced with `var(--…)` via inline `style` (SVG attrs don't resolve `var()` — style is required). `HOP_COLORS` array removed; `hopColor()` helper now returns `var(--hop-N)` strings. React.memo preserved by keeping props as primitives and computing style objects inside child components from those scalars.
- Slate chrome colours in multi-hop badge / collapse indicator rects mapped to existing shadcn tokens (`var(--muted)`, `var(--card)`, `var(--border)`, `var(--muted-foreground)`) rather than minting new tokens — those elements are structural chrome, not domain-tagged.

**Deviations from plan:**
- Included admin app in the CSS slim-down (plan said observer/committer only). Rationale: admin's CSS was a verbatim copy; leaving it alone would have diverged forever.
- TreeView refactor used inline `style` with CSS `var()` rather than the plan's preferred "props resolved at mount" path. Style is cleaner and the sole option for SVG since presentation attributes don't run CSS cascade.
- `setTestingMode` / feature flags: untouched (unrelated).
- Tests skipped with explicit user waiver ("I AUTHORIZE YOU TO SKIP WRITING TESTS THIS TIME"). Validation was build-based (all three `vite build` green; generated CSS contains all 15 domain tokens; `--hop-0` resolves to the shared theme.css value).

**Pre-existing issues surfaced (NOT fixed in this phase — flag for separate issue):**
- `packages/shared/src/components/NodeDetail.tsx` has an unused `cap` variable (TS6133).
- Observer test files reference `screen`/`waitFor` from `@testing-library/react` v16 where those are not re-exported.
- These block `tsc -b`; `vite build` succeeds because it skips typecheck. Consider filing a cleanup issue.

**Tasks:**
1. Create `packages/shared/src/styles/theme.css` containing a **single dark theme** token set. Replace current light-theme values with cool, professional dark placeholders (zinc/slate base, single saturated accent — e.g. `oklch(0.70 0.15 230)` cyan-ish). Values are placeholders; easy to swap.
2. Add **domain-specific tokens** on top of shadcn's base set:
   - `--hop-0`, `--hop-1`, `--hop-2`, `--hop-root`, `--hop-multi` (graph node colors per hop)
   - `--hop-connected`, `--hop-selected`, `--hop-dimmed` (graph interaction states)
   - `--graph-edge`, `--graph-edge-active`, `--graph-edge-chain` (edge colors)
   - `--status-pending`, `--status-submitted`, `--status-confirmed`, `--status-failed` (tx lifecycle)
3. Register tokens with Tailwind in the `@theme inline` block so they're usable as classes (`bg-hop-0`, `text-status-confirmed`).
4. Delete `observer/src/index.css` and `committer/src/index.css`; each app imports `@armada/crowdfund-shared/styles/theme.css` from its own tiny bootstrap CSS (or directly from `main.tsx`).
5. Remove `color-scheme: light dark`, remove `@custom-variant dark`. Document in a top-of-file comment that this is a dark-only app.
6. Refactor `TreeView.tsx` `HOP_COLORS` and other hex literals to read CSS vars via `getComputedStyle(document.documentElement).getPropertyValue('--hop-0')` at render time — or (preferred) pass them in as props resolved once at mount.

**Acceptance:**
- Both apps load with a dark background.
- TreeView renders with same structure but hop colors come from CSS vars (verify by tweaking a token value and seeing nodes change).
- No file outside `shared/` declares color tokens.
- `grep -rE '#[0-9a-f]{6}' crowdfund-ui/packages/shared/src/components/` returns zero hex literals (except maybe in tests).

---

### Phase 2 — Install shadcn component set into shared

**Branch:** `iskay/crowdfund-ui-shadcn`
**Effort:** ~0.5 day
**Depends on:** Phase 1

**Open decisions for the Phase 2 agent (resolve before running `shadcn add`):**

1. **Shared-scoped `components.json`.** None exists in `packages/shared/` yet. Each app has its own pointing `tailwind.css → src/index.css`. A shared-scoped one needs to be created and should probably point at `src/styles/theme.css` so any new CSS shadcn writes lands in the right file. Decide whether to delete the three per-app `components.json` files at the same time (they become vestigial if all ui primitives live in shared).

2. **`@` path alias in shared — conflicts with existing convention.** `packages/shared/CLAUDE.md` states: "No `@` path alias. Use relative imports within this package." But shadcn's generator bakes `@/components`, `@/lib/utils`, etc. into every file. Three paths, none obviously right:
   - Add an `@` alias to `packages/shared/tsconfig.json` + `vite`/`tsup` resolvers — breaks the convention explicitly.
   - Configure `components.json` aliases as relative — shadcn's CLI may not honor this cleanly; test first.
   - Let shadcn generate with `@` and post-process imports to relative — ugly but convention-preserving.
   
   Pick one and document in shared/CLAUDE.md before merging Phase 2.

3. **Missing deps in `packages/shared/package.json`.** shadcn-generated components require `clsx`, `tailwind-merge`, `class-variance-authority`, and various `@radix-ui/*` packages. Shared currently declares none. Add to `dependencies` (treat shared's consumers as black-box) or `peerDependencies` (let the apps pin versions). Apps already have `tailwind-merge` in their own devDeps — whichever choice is made, avoid version drift between apps and shared.

**Other heads-up (not decisions, just context):**
- No shadcn components are installed anywhere yet (no existing `ui/` dirs to conflict with or migrate from).
- Pre-existing `tsc -b` failures in observer tests + `NodeDetail.tsx` unused var are flagged under Phase 1 actuals — don't try to fix them in Phase 2; file a separate issue.
- Theme tokens Phase 2 will consume are all in `packages/shared/src/styles/theme.css`. Button/Badge variant CVA configs should pull from there (e.g. `destructive` → `var(--destructive)`). Phase 5 will extend Badge with hop variants — don't over-engineer that now.

**Tasks:**
1. Run `npx shadcn@latest add button input label card dialog tooltip tabs select separator skeleton alert scroll-area popover sheet badge` — but configure shadcn to output into `packages/shared/src/components/ui/` rather than an app-local folder. May require editing `components.json` in shared.
2. Re-export `ui/*` from `packages/shared/src/index.ts` as `export * from './components/ui'` (or a namespaced export).
3. Verify components render in both apps (write a throwaway `<Button variant="default">test</Button>` in each App.tsx, then remove).

**Acceptance:**
- Both apps compile and render a shadcn Button identically.
- Variants are driven by Phase 1 tokens (primary = accent color, destructive = red, etc.).

**Note:** shadcn writes files directly into your repo — they are **yours to edit**. Prefer editing the generated file over wrapping it.

---

### Phase 3 — Shared AppShell (header + footer + page container)

**Branch:** `iskay/crowdfund-ui-shell`
**Effort:** ~1 day
**Depends on:** Phase 2

**Tasks:**
1. Create `packages/shared/src/components/AppShell.tsx` with slots:
   - `headerLeft`: brand/app name
   - `headerCenter`: (optional) breadcrumb or title
   - `headerRight`: children — each app passes its own (observer: nothing / a simple "connect for more" link to committer; committer: wallet connect button, chain indicator)
   - `children`: page content
   - `footer`: small — version number, "Built on Armada", external links
2. Responsive container: max-width centered, consistent horizontal gutter.
3. Network indicator badge (reads from `config/networks.ts` or env) — shows "Local", "Sepolia", etc.
4. Replace each app's `App.tsx` top-level layout with `<AppShell>`. Leave page-body layout (tree + table grid) untouched for now.

**Acceptance:**
- Both apps share the exact same header chrome structurally, differing only in the `headerRight` slot.
- Header is sticky on scroll.
- Network badge visible on both.
- Responsive: header collapses cleanly below ~640px (mobile menu via shadcn Sheet).

---

### Phase 4 — Wire up sonner + transaction UX overhaul

**Branch:** `iskay/crowdfund-ui-toasts`
**Effort:** ~0.5 day
**Depends on:** Phase 2

**Tasks:**
1. Mount `<Toaster />` (sonner) at AppShell level.
2. Create `packages/shared/src/hooks/useTxToast.ts` exposing helpers like `notifyTxPending(hash)`, `notifyTxConfirmed(hash)`, `notifyTxFailed(err)`. Link to block explorer using chain config.
3. Refactor `TransactionFlow` consumers (commit, invite, claim) to call toast helpers instead of mounting a full-panel `TransactionFlow`. Keep `TransactionFlow` as a component for cases where a full panel IS warranted (multi-step flows) but it should be opt-in, not default.
4. Add a "last tx" chip in the AppShell header on committer — clicking reopens a detail popover.

**Acceptance:**
- Committing USDC surfaces a single toast progressing pending → submitted (with explorer link) → confirmed/failed.
- Full-panel TransactionFlow no longer auto-renders for simple flows.
- `grep -r "sonner" crowdfund-ui/packages` shows active usage, not just the import.

---

### Phase 5 — Replace ad-hoc Buttons / Tabs / Inputs with shadcn

**Branch:** `iskay/crowdfund-ui-components-migration`
**Effort:** ~1–1.5 days
**Depends on:** Phase 2, 3, 4

**Tasks:**
1. Audit every `<button className="…">` in observer and committer. Replace with `<Button>`.
2. Consolidate the three different mobile tab bar implementations into one — use shadcn `<Tabs>`.
3. Replace every `<input>` with shadcn `<Input>` + `<Label>`.
4. Wrap addresses / hop badges / status pills in shadcn `<Badge>` with variants driven by theme tokens (`variant="hop-0"`, etc. — may require extending the Badge cva config).
5. Info tooltips: wrap a small `<Info size={14}/>` from lucide in shadcn `<Tooltip>`; use consistently wherever domain terms appear (hop, pro-rata, slot, allocation, delegation).

**Acceptance:**
- Visual consistency across the two apps when viewed side-by-side.
- No regression — all prior click/hover/focus behaviors still work.
- Keyboard navigation works (shadcn gives this for free via Radix).

---

### Phase 6 — Skeletons, empty states, error boundaries

**Branch:** `iskay/crowdfund-ui-feedback-states`
**Effort:** ~1 day
**Depends on:** Phase 2, 5

**Tasks:**
1. Skeleton loaders (shadcn `<Skeleton>`) for:
   - TableView rows during initial event fetch
   - StatsBar numbers before first data
   - TreeView — placeholder grey circles with pulse
2. Empty state components (`packages/shared/src/components/EmptyState.tsx`) for:
   - "No participants yet"
   - "No invites generated"
   - "Wallet not connected" (committer)
   - "Crowdfund not yet open" / "Finalized" / "Cancelled"
   Each takes a lucide icon, title, description, optional primary CTA.
3. React error boundaries (`packages/shared/src/components/ErrorBoundary.tsx`) at:
   - App root (catches fatal errors, shows reload button)
   - Each major panel (tree, table, action panel) — one failure doesn't blank the page
4. Unified `<ErrorAlert>` component built on shadcn `<Alert variant="destructive">` — replace every inline red-bg div.

**Acceptance:**
- Opening the app on a slow connection shows skeletons, not blanks.
- Pulling the plug on the RPC shows a friendly error boundary, not a blank page.
- All empty states visually match each other.

---

### Phase 7 — TanStack Query wrap of RPC + ENS hooks

**Branch:** `iskay/crowdfund-ui-query`
**Effort:** ~1 day
**Depends on:** Phase 6 (error boundaries catch query failures)

**Tasks:**
1. Add `@tanstack/react-query`, mount `QueryClientProvider` at AppShell level.
2. Rewrite these hooks to use `useQuery` / `useInfiniteQuery`:
   - `useContractEvents` — long-polling today; react-query with `refetchInterval` is cleaner
   - `useENS` — retry with backoff on failure; fallback to truncated address if permanently unresolved
   - `useAllocations` (committer)
3. Expose `isLoading`, `isError`, `error`, `isRefetching` from each hook so Phase 6 skeletons know when to appear.
4. Add a top-level reconnection banner (stale data warning) when the query client is paused/offline.

**Acceptance:**
- Kill the RPC mid-session → banner appears → restore → banner disappears.
- ENS failures retry 3× with exponential backoff, then silently fall back.
- Network tab shows no redundant in-flight requests (react-query dedupes).

---

### Phase 8 — react-hook-form + zod on commit / invite forms

**Branch:** `iskay/crowdfund-ui-forms`
**Effort:** ~1 day
**Depends on:** Phase 5

**Tasks:**
1. Add `react-hook-form`, `zod`, `@hookform/resolvers`.
2. Build a reusable `<AmountInput>` in shared: USDC unit label, Max button (wired to a prop-provided ceiling — wallet balance OR remaining allocation OR pro-rata max), thousand-separator formatting, inline error text.
3. Convert Commit tab and Invite tab to react-hook-form + zod schemas. Validation rules:
   - Amount > 0, ≤ balance, ≤ hop cap, ≤ remaining eligible slot
   - Address is valid 0x... (use viem's `isAddress`)
   - Invite count ≥ 1, ≤ remaining slots
4. Disable submit button until form is valid. Show inline errors under fields, not in banners.

**Acceptance:**
- Invalid amounts can't be submitted.
- Errors appear under the relevant field, not globally.
- Max button works in all three contexts (balance cap, hop cap, eligibility cap) — whichever is smallest wins and a tooltip explains why.

---

### Phase 9 — framer-motion micro-animations

**Branch:** `iskay/crowdfund-ui-motion`
**Effort:** ~0.5 day
**Depends on:** Phase 5, 6

**Tasks:**
1. Add `framer-motion`.
2. Tab panel transitions: fade + slight slide on `<Tabs>` content change.
3. Dialog/Popover enter/exit (Radix already animates; framer gives finer control if needed — don't over-do).
4. StatsBar: animated number on value change (`motion.span` with `initial={{opacity: 0, y: -4}}` + key on value).
5. Copy-to-clipboard confirmation: small checkmark fade on addresses / invite links / tx hashes. Pair with sonner toast.
6. Hover scale on interactive cards (subtle — 1.01).

**Acceptance:**
- Doesn't feel excessive. If it feels like a casino, back off. Motion should confirm, not distract.
- Respects `prefers-reduced-motion` (framer honors this via `useReducedMotion`).

---

### Phase 10 — Invite graph: spike + polish

**Branch:** `iskay/crowdfund-ui-graph-spike` (for spike), then `iskay/crowdfund-ui-graph-polish`
**Effort:** spike 0.5 day, polish 1.5–2 days
**Depends on:** Phase 1 (for theme tokens)

**Current state:** `packages/shared/src/components/TreeView.tsx` (596 lines) — vanilla d3-hierarchy + d3-zoom. Working, handles current scale, hop collapse at >20 children, hover tooltips, pan/zoom.

#### Step A — Spike `@xyflow/react` on a parallel branch

1. Create a new React Flow-based TreeView rendering the same data.
2. Time-box: **half a day.** Don't polish.
3. A/B compare with current d3 version on same dataset (use `crowdfund:populate` to generate ~500+ nodes). Score on:
   - Visual quality out of the box
   - Smoothness of pan/zoom with 500+ nodes
   - How easy it is to put identicons + ENS avatars into nodes
   - Customizability of edges (thickness, label, color per hop)
   - Bundle size impact

**Decision gate:** user reviews the spike. If React Flow clearly wins on visuals and perf is acceptable → Step B-React. Else → Step B-d3.

#### Step B-d3 (default if spike is ambiguous) — Polish existing d3 implementation

1. Wire all colors to Phase 1 theme tokens (no more `HOP_COLORS` array of hex).
2. Node visuals: replace plain circles with deterministic identicons. Use `@metamask/jazzicon` (small, deterministic from address) or `@dicebear/collection` (many styles, larger). For ENS-resolved addresses, try to fetch avatar; fall back to identicon.
3. Replace SVG tooltip with Radix `<Popover>` on click (and `<HoverCard>` on hover) — allows richer content: commitment amount, invite-path breadcrumb, "view in table" button, copy-address button.
4. Add d3-driven minimap (corner of graph, shows whole tree with current viewport rectangle).
5. Add legend explaining hop colors, multi-hop marker, connected-wallet highlight.
6. Add controls: zoom-to-fit, zoom-to-connected-address, zoom-to-node-on-search.
7. Smooth layout transitions with d3-transition on expand/collapse (tune durations — current is fine, just confirm).
8. Extract magic numbers (collapse threshold, node radius, transition duration) to constants at top of file and document them.

#### Step B-React (if spike wins)

1. Replace TreeView.tsx with React Flow version.
2. Custom node components: each node is full JSX → identicons, ENS names, hop badge, optional avatar — all trivial.
3. Custom edge components for hop-to-hop lines.
4. Preserve selection, pan/zoom, minimap (React Flow has a `<MiniMap>` built in), collapse logic.
5. Performance check with 500+ nodes — bail back to d3 if it chokes.

**Acceptance (either path):**
- Nodes look distinct (identicons or avatars).
- Colors come from theme tokens (tweak a token → graph updates).
- Rich tooltip/popover on node click.
- Minimap + legend + zoom-to-fit present.
- Graph degrades gracefully at >500 nodes.

---

### Phase 11 — Micro-interactions final pass

**Branch:** `iskay/crowdfund-ui-final-polish`
**Effort:** ~0.5 day

**Tasks:**
- Copy-to-clipboard on every address/hash/invite-link (paired with toast + check icon, wired in Phase 9)
- Consistent focus rings on all interactive elements (shadcn + Radix give this — audit for any remaining ad-hoc inputs)
- Confirm loading-spinner-in-button pattern is consistent (no button width jump)
- Accessible labels on every icon-only button (`aria-label`)
- Audit color contrast (WCAG AA) against final dark theme
- Check keyboard navigation end-to-end on both apps

**Acceptance:**
- Lighthouse accessibility score ≥ 95 on both apps.
- Tab-key navigation works front-to-back without mouse.
- No console warnings.

---

## 5. Total effort & rough order-of-merge

| Phase | Effort | Can start after |
|---|---|---|
| 1. Theme | 0.5d | — |
| 2. shadcn install | 0.5d | 1 |
| 3. AppShell | 1d | 2 |
| 4. Sonner + tx toasts | 0.5d | 2 |
| 5. Component migration | 1–1.5d | 2, 3, 4 |
| 6. Skeletons / empty / errors | 1d | 2, 5 |
| 7. TanStack Query | 1d | 6 |
| 8. Forms | 1d | 5 |
| 9. Motion | 0.5d | 5, 6 |
| 10. Graph spike + polish | 2–2.5d | 1 (can run in parallel with 2–9) |
| 11. Final polish | 0.5d | all |

**Total: ~10–12 days** of focused work. Phases 1–4 (~2.5 days) alone deliver a big jump in feel; worth a user review at that checkpoint before continuing.

Phase 10 can run **in parallel** with 2–9 on a separate branch since it only depends on theme tokens.

---

## 6. How future agents should use this doc

- **Start of a new session:** read this file end-to-end plus CLAUDE.md.
- **Before picking up a phase:** check git log for which phase branches are already merged. Ask the user which phase to tackle if unclear.
- **Mark progress here:** when a phase is merged to `main`, update its status inline (add `✅ Merged in #<PR>` under the phase header). Do not delete the phase.
- **If a phase changes in scope:** edit this doc; don't start a parallel one.
- **When all phases are merged:** archive this file to `.claude/archive/CROWDFUND_UI_POLISH.md` and add a one-line summary of what was done.

---

## 7. Open questions / things to escalate

- **Brand identity**: token values in Phase 1 are placeholders. When design lands, a single PR should re-value `theme.css`; the token names should remain stable.
- **Graph library choice**: pending Phase 10 spike.
- **Observer ENS/avatars**: committer already resolves ENS via `useENS` — ensure the shared TreeView consumes the same data on observer. Should already work but verify.
- **Accessibility baseline**: we haven't defined a target (AA vs AAA). AA is assumed. Flag if user wants stricter.
- **i18n**: not in scope now. If added later, will need to refactor all string literals — flag early.
- **Admin app**: explicitly out of scope. If a future change to shared breaks admin, fix admin but don't polish it.

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **Hop** | Social distance from the initial whitelist (hop 0 = whitelisted, hop 1 = invited by hop 0, hop 2 = invited by hop 1). Caps at hop 2. |
| **Slot** | An invite slot — each participant has a finite number they can pass to invitees. |
| **Pro-rata** | If the crowdfund is oversubscribed at a hop, commitments are scaled down proportionally. |
| **Connected address** | The wallet currently connected in the committer app. Gets visual emphasis in the graph and pinned to top of the table. |
| **Multi-hop** | An address that was invited by participants at more than one hop — rendered once at its lowest hop with a visual marker. |
| **Finalization** | After cap hit and time elapsed, admin calls `finalize()` → commitments become claimable as ARM. |
| **Cancellation** | Admin can cancel → commitments become refundable as USDC. |
