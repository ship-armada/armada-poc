# Crowdfund UI Polish Plan

> **Status:** Planning doc — active. Archive to `.claude/archive/` once every phase has landed and the umbrella → `main` PR is merged.
> **Scope:** Observer and Committer apps only. Admin app is internal-only and stays bare-bones.
> **Branch:** all work lands directly on `iskay/crowdfund-ui-polish` — no per-phase feature branches, no PRs to `main` until the polish pass is finished. See §0.

---

## 0. Branch strategy (locked)

All polish work lands **directly on a single long-lived branch**, `iskay/crowdfund-ui-polish`, off `main`. No per-phase feature branches. No PRs to `main` until the polish pass is finished.

Each phase is one commit (or a short series of commits) on the umbrella. The umbrella's git history is the phase log. There is no intermediate review gate beyond the commit-message discipline and the Actuals block in this doc.

Why: earlier drafts of this plan tried to keep per-phase branches as "independently reviewable within the umbrella", but the polish work is cross-cutting and every phase touches the same surfaces. Forking/merging per phase was churn without review value. The umbrella branch itself is the reviewable unit; the final landing decision (squash/merge/rebase onto main) is made once the polish pass is complete.

```
main
 └─ iskay/crowdfund-ui-polish ← umbrella (long-lived)
     │  phase 1 commits — dark-only theme
     │  phase 2 commits — shadcn primitives
     │  Phase 1 carry-over tsc cleanup
     │  phase 3 commits — AppShell   ← most recent
     │  phase 4 commits — toasts     ← next
     └  …
```

**Rules for phase agents:**
- Check out `iskay/crowdfund-ui-polish` directly and commit onto it. Do **not** create a `iskay/crowdfund-ui-<phase>` branch.
- Do not force-push the umbrella. Do not rewrite history.
- Unrelated fixes needed to unblock a phase (e.g. the Phase 1 tsc cleanup) can go in as their own commit on the umbrella — doesn't need to wait for phase boundaries.
- Squash decisions for landing on `main` are deferred until the polish pass is complete.
- **Do not open PRs** for individual phases. If the user asks you to produce a reviewable surface (e.g. a PR to show stakeholders), push the umbrella to origin and open a draft PR `iskay/crowdfund-ui-polish → main` — but only on explicit request, not as part of a phase's normal close-out.

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
| D7 | **Observer and Committer must be fully responsive for mobile.** Admin is **exempt** (launch-team / security-council users are on desktop; see CLAUDE.md note that admin stays bare-bones). | Every shared component must work from ≥320px wide up through desktop. Each phase touching layout must include a mobile pass before marking done. AppShell's header collapses into a shadcn `<Sheet>` below ~640px. TreeView and TableView must be usable on phones — consider stacked (vs side-by-side) layouts on narrow viewports. Test with Chrome DevTools device emulation at minimum; budget one extra hour per phase for mobile-specific tweaks. |

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

## 4. Shared-first conventions (apply to every phase)

Multiple agents will implement phases independently. These rules keep the codebase coherent. Before opening a PR, agents MUST self-check against every item below.

### Styling

1. **No hex literals, no `rgb()`/`hsl()` literals, no named color utilities for domain concepts.** Use theme tokens from `packages/shared/src/styles/theme.css` exclusively. Hop colors are `text-hop-0`/`bg-hop-0`, tx status is `text-status-confirmed`, etc. Self-check: `rg -nE '#[0-9a-f]{3,8}\b|\brgb\(' crowdfund-ui/packages/ --glob '!**/theme.css' --glob '!**/node_modules/**'` on your diff — zero matches.
2. **No inline `style={{...}}` for color, spacing, or typography.** Allowed only for values that can't be expressed in Tailwind (e.g. SVG `var()` references in `TreeView.tsx`, dynamic computed coordinates).
3. **Class merging uses `cn()` from `@armada/crowdfund-shared`.** Not template literals, not string concat. Shadcn primitives already do this; follow suit.
4. **Dark theme only.** Never introduce `.dark` selectors, `@custom-variant dark`, or light-mode fallbacks (D1).

### Components

5. **Never create a new `Button`, `Input`, `Card`, `Dialog`, `Tooltip`, etc. in an app.** Import from the shared barrel. If a variant is missing, extend the shared primitive's CVA config in place — do not wrap it in an app-local component.
6. **No new `src/components/ui/` directories in observer, committer, or admin.** The shadcn installation lives only in `packages/shared/`. Per-app `components.json` files were deleted intentionally; don't recreate them.
7. **Domain components (graph nodes, hop badges, participant rows, tx toasts) go in `packages/shared/src/components/`** once more than one app uses them. If you build it app-local first to ship the phase, flag it in the PR description so a future phase can promote it.

### Utilities and hooks

8. **Search before writing.** Before creating a formatter, hook, or helper, grep `packages/shared/src/lib/` and `packages/shared/src/hooks/`. Notably present already: `formatUsdc`, `formatUsdcPlain`, `parseUsdcInput`, `formatArm`, `truncateAddress`, `formatCountdown`, `hopLabel`, `phaseName`, `phaseColor`, `estimateAllocation`, `buildGraph`, `mergeEvents`, `parseCrowdfundEvent`, `createProvider`, `fetchLogs`, IndexedDB cache helpers, `useContractEvents`, `useGraphState`, `useSelection`, `useENS`, `useAllocations`.
9. **Icon set = `lucide-react` only.** Already pulled in transitively via shadcn. Don't add Heroicons, Radix Icons, Phosphor, etc.
10. **State: Jotai atoms from shared for cross-app concerns; local `useState` for component-local.** No new React Contexts. Atoms worth knowing: `crowdfundEventsAtom`, `crowdfundGraphAtom`, `selectedAddressAtom`, `searchQueryAtom`, `hoveredAddressAtom`, `ensMapAtom`.
11. **Contract I/O uses ethers v6.** viem stays scoped to wagmi/RainbowKit wallet concerns in the committer. Don't mix inside a single module.

### Imports and boundaries

12. **Cross-package imports go through the barrel:** `import { X } from '@armada/crowdfund-shared'`. Never reach into `@armada/crowdfund-shared/src/...` from an app — the barrel is the contract.
13. **Within `packages/shared/`, use relative imports with `.js` extensions** (shared convention). No `@/` path alias in shared.
14. **Do not modify** `contracts/railgun/logic/`, `_legacy/`, `usdc-v2-frontend/`, `ArmadaYieldVault`, testing-mode code, or the Phase 1 token values in `theme.css` (brand identity owns that PR separately).

### Process

15. **Branch off `iskay/crowdfund-ui-polish`; PR into it, not main** (see §0).
16. **Mobile responsiveness is non-negotiable for observer + committer** (D7). Admin exempt. Mobile smoke at ≥375px viewport before requesting review.
17. **When a phase requires a tool invocation that shows state changes outside the repo** (a `gh issue create`, a `git push`, etc.), ask first unless the plan already authorizes it.
18. **Test waiver is per-phase.** Don't assume the previous phase's waiver carries forward. Ask the user. Record the outcome in the phase's "Actuals" block.
19. **Before committing, run**: `npx vite build` in each app you touched (must be green), plus `npx tsc -b` in any package whose `tsc -b` was clean pre-phase (don't regress). Shared + committer + admin have pre-existing baseline errors tracked in issue #259 — don't fix them inside a phase PR.
20. **Surface friction.** If one of these rules is wrong for your phase, propose a revision here (end-of-response `SUGGESTED INSTRUCTION UPDATE:` pattern per root CLAUDE.md). Don't edit this doc autonomously to suit your current task.

---

## 5. Plan — ordered phases

Each phase lands as one or more commits directly on the umbrella branch (see §0). Each phase should end green: `npm run test` passes, both apps load and function.

### Phase 1 — Consolidate + dark-mode-only theme (foundation)

**Status:** ✅ Landed directly on `iskay/crowdfund-ui-polish` (commit `f454f7c`).
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

**Status:** ✅ Landed on `iskay/crowdfund-ui-polish` (commit `e8ab971`; Phase 1 tsc carry-over `2476d51`).
**Effort:** ~0.5 day
**Depends on:** Phase 1

**Actuals (as shipped):**
- `crowdfund-ui/packages/shared/components.json` — new file. `style: new-york`, `tailwind.css: src/styles/theme.css` (points at the Phase 1 token file so shadcn writes into the right CSS), aliases use the conventional `@/…` form.
- `crowdfund-ui/packages/shared/src/lib/utils.ts` — new, exports `cn()` (clsx + tailwind-merge).
- `crowdfund-ui/packages/shared/src/components/ui/*.tsx` — 15 primitives: button, input, label, card, dialog, tooltip, tabs, select, separator, skeleton, alert, scroll-area, popover, sheet, badge. Generated by `shadcn@4.4.0`, post-processed: `@/` imports rewritten to relative with `.js` extensions (shared convention), leading `"use client"` directives stripped (non-RSC project), two-line `ABOUTME` headers prepended.
- `crowdfund-ui/packages/shared/package.json` — added deps: `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, `radix-ui` (the **unified** meta-package, not per-component `@radix-ui/react-*`). shadcn v4 standardised on `radix-ui` and the CLI hardcodes `npm install radix-ui` in its post-generate step, so individual subpackages won't satisfy it.
- `crowdfund-ui/packages/shared/src/index.ts` — extended with named re-exports for all 15 primitives and `cn`.
- Per-app `components.json` files deleted from observer, committer, and admin — they were vestigial (no app ever had a `ui/` directory). Shared owns the single shadcn installation.
- `crowdfund-ui/packages/shared/CLAUDE.md` — added a "UI Primitives (shadcn/ui)" section documenting regeneration workflow, the `@/` → relative rewrite step, the `legacy-peer-deps` env var requirement, and the "edit in place" rule.

**Deviations from plan:**
- **Alias approach**: plan proposed configuring `components.json` aliases as package-root-relative strings. In practice, shadcn v4 ignores non-`@/`-prefixed aliases and defaults to `@/…` regardless. Used the standard `@/…` aliases and post-processed imports. Post-processing is mechanical (a two-rule sed) and contained; documented in shared/CLAUDE.md for future regenerations.
- **Where shadcn writes files**: because shared has no `@` → filesystem mapping in `tsconfig.json`, shadcn wrote generated files into a literal `./@/components/ui/` directory (treating `@` as a folder name). Moved them into `src/components/ui/` and deleted the stray `@` directory. Heads-up for any future `shadcn add` run: the same manual move is needed.
- **Radix packaging**: switched from individual `@radix-ui/react-*` packages (as originally outlined in Decision D-C) to the unified `radix-ui` meta-package. This is a shadcn v4 requirement; the generated primitives import via `import { Slot } from "radix-ui"` etc.
- **`legacy-peer-deps`**: shadcn's auto-install of `radix-ui` fails ERESOLVE against Railgun SDK peer ranges in the workspace. Resolved by running `npm_config_legacy_peer_deps=true npx shadcn@latest add …`. The root `.npmrc` already has `legacy-peer-deps=true`, but shadcn spawns npm with an environment that doesn't inherit it cleanly — explicit env var is required.
- **Tests skipped with explicit user waiver** ("yes i authorize you to skip tests for this"). Validation was build-based: all three apps smoke-built with a temporary `__smoke__.tsx` that imports every primitive; final builds after smoke removal are also green.

**Pre-existing issues surfaced (NOT fixed in this phase — same as Phase 1 carry-over):**
- `packages/shared/src/components/NodeDetail.tsx` — unused `cap` variable (TS6133).
- Observer test files reference `screen`/`waitFor` from `@testing-library/react` v16 where they are not re-exported.
- These still block `tsc -b`; `vite build` succeeds because it skips typecheck. File a cleanup issue (flagged in Phase 1 actuals — carry through).

**Open decisions for the Phase 2 agent (resolved — kept for history):**

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

**Status:** ✅ Landed on `iskay/crowdfund-ui-polish` (commit `dff93be`).
**Effort:** ~1 day
**Depends on:** Phase 2

**Actuals (as shipped):**
- `crowdfund-ui/packages/shared/src/components/AppShell.tsx` — new. Slot-based API: `appName`, `network` (`'local' | 'sepolia' | (string & {})`), `headerRight`, `mobileMenu`, `footer`, `children`. Sticky header (`sticky top-0 z-40`) with `bg-background/80 backdrop-blur`, mobile `<Sheet>` (left-side) triggered by a `<Menu>` hamburger that only renders when `mobileMenu` is supplied, and a `<DefaultFooter>` rendering `v{VITE_APP_VERSION} · Built on Armada · <network> · GitHub`. `NetworkBadge` co-exported. Sheet uses `z-50` (Radix default) so it covers the `z-40` sticky header.
- `crowdfund-ui/packages/shared/src/index.ts` — extended with `AppShell`, `NetworkBadge`, `AppShellProps`, `AppShellNetwork`.
- `crowdfund-ui/packages/observer/vite.config.ts` + `crowdfund-ui/packages/committer/vite.config.ts` — each `define`-injects `import.meta.env.VITE_APP_VERSION` from its own `package.json.version` at build time. Admin untouched (out of scope).
- `crowdfund-ui/packages/observer/src/App.tsx` — three render paths (deploy-error + loading stayed unwrapped; pre-open, empty, main) now wrap in `<AppShell appName="Observer" …>`. Hand-rolled `Header()` helper removed. Added local `ParticipateLink` + `ObserverMobileMenu` components reading `VITE_COMMITTER_URL` (default `http://localhost:5174`).
- `crowdfund-ui/packages/committer/src/App.tsx` — main render wraps in `<AppShell appName="Committer" …>`. `headerRight` composed inline from existing balance text + RainbowKit `ConnectButton`; mobile menu duplicates the wallet chrome in a stacked layout. `{/* TODO(Phase 4): last-tx chip slot goes here */}` placeholder left in both places. Hand-rolled header div removed; mobile tab bar and action tab bar left untouched (Phase 5).

**Deviations from plan:**
- **Shared `import.meta.env` typing.** Shared has no `vite-env.d.ts` (it's a library) so `import.meta.env.VITE_APP_VERSION` fails `tsc` in shared with TS2339. Resolved with a contained cast: `(import.meta as unknown as { env?: Record<string, string | undefined> }).env`. Documented inline. Preferred over adding a vite-env.d.ts to a non-Vite library package.
- **Observer full-screen fallback states (deploy error, loading).** Left unwrapped from `AppShell` — they're pre-deployment states without network/header context, and wrapping them would only add chrome the user can't act on. Matches original behavior.
- **Version semantics.** Injects each app's own `package.json.version`, not a shared version. Both apps currently at `0.1.0`. Falls back to `"dev"` at runtime if `VITE_APP_VERSION` is unset (e.g. during tests).
- **Tests skipped** with explicit user waiver. Validation was build-based (all three `vite build` green; observer `tsc -b` clean; shared/committer/admin `tsc -b` at pre-existing #259 baseline with no new errors) plus observer `vite dev` serving HTTP 200 with expected HTML shell.

**Pre-existing issues NOT addressed in Phase 3** (tracked in #259):
- `committer/src/App.tsx` has an unused `walletENS` local (line 175). Surfaced during audit, left alone — CLAUDE.md rule is to not make unrelated fixes inside a phase.
- Shared test files: `useAllocations.test.ts` unused `beforeEach`/`act`, `rpc.test.ts` `JsonRpcResult` type mismatch.
- Committer `ClaimTab.test.tsx`, `InviteLinkRedemption.test.tsx`, `InviteTab.test.tsx`, `useProRataEstimate.test.ts`, plus `wagmiAdapter.ts` strict-null, `CommitTab.tsx` unused `HOP_CONFIGS`.
- Admin `useRole.test.ts` missing test-runner type definitions.

**Pre-flight for the Phase 3 agent (resolve before writing code):**

1. **Mobile Sheet contents — confirmed scope (locked via D7 above).** Observer + committer must be fully responsive (admin exempt). For the mobile header Sheet (<640px breakpoint):
   - **Observer:** Network badge + a "Participate" CTA linking to the committer's URL. Nothing else.
   - **Committer:** Wallet connect button (RainbowKit), chain indicator, network badge. *The last-tx chip belongs to Phase 4 — leave an intentional slot or a commented placeholder and implement it there.*
   - **Admin:** Out of scope; do not modify the admin header.

2. **Network badge data source.** The committer already reads chain config via `src/config/wagmi.ts` / `src/config/networks.ts`. Observer uses its own `src/config/network.ts` (note: singular; check the actual file). Pick one of these as the authoritative source for the AppShell's badge — either (a) pass the chain/network label in as a prop so each app decides, or (b) read `import.meta.env.VITE_NETWORK` directly in AppShell. Prop-passing (a) is the cleaner seam — AppShell should not couple to env vars.

3. **Footer content.** Plan says "version number, 'Built on Armada', external links". Version: read from shared's `package.json` (or each app's) at build time — prefer a `VITE_APP_VERSION` injected via vite config, fall back to a hardcoded "dev" in local. External links: minimal — GitHub repo, docs (if any), done. No need to design this to spec; keep it small and make it easy to swap.

4. **Page-body layout untouched.** Plan explicitly says so. Do not refactor the tree + table grid in Phase 3; it stays in each app's `App.tsx` as children of `<AppShell>`. TreeView/TableView mobile responsiveness is a Phase 6 / Phase 10 concern, not this phase's.

**Tasks:**
1. Create `packages/shared/src/components/AppShell.tsx` with slots:
   - `headerLeft`: brand/app name
   - `headerCenter`: (optional) breadcrumb or title
   - `headerRight`: children — each app passes its own (observer: "Participate" link; committer: wallet connect + chain indicator; admin: minimal or unchanged)
   - `children`: page content
   - `footer`: small — version number, "Built on Armada", external links
2. Responsive container: max-width centered, consistent horizontal gutter. Works from 320px up.
3. Network indicator badge (via prop — see pre-flight #2) — shows "Local", "Sepolia", etc.
4. Replace each app's `App.tsx` top-level layout with `<AppShell>`. Leave page-body layout (tree + table grid) untouched for now.
5. Mobile menu via shadcn `<Sheet>` (already available in the barrel from Phase 2). Contents per pre-flight #1.

**Acceptance:**
- Both apps share the exact same header chrome structurally, differing only in the `headerRight` slot.
- Header is sticky on scroll.
- Network badge visible on both.
- Responsive: header collapses cleanly below ~640px (mobile menu via shadcn Sheet).
- **Mobile smoke test**: at 375px (iPhone SE) viewport, header + content do not horizontally scroll; the Sheet opens, closes, and is dismissable with the backdrop.
- No regression: existing observer/committer features still work.

**Existing TS baseline after Phase 1 cleanup:**
- Observer `tsc -b` is clean.
- Shared + committer + admin still have unrelated pre-existing `tsc -b` errors tracked in **issue #259**. Phase 3 should not attempt to fix them; if changes unintentionally introduce *new* errors, fix those in Phase 3. Validation path: continue relying on `vite build` for all three apps, plus `npx tsc -b` in observer (clean) and shared (should stay at #259's baseline).

---

### Phase 4 — Wire up sonner + transaction UX overhaul

**Status:** ✅ Landed on `iskay/crowdfund-ui-polish` (commit `694302b`).
**Effort:** ~0.5 day
**Depends on:** Phase 2

**Actuals (as shipped):**
- `crowdfund-ui/packages/shared/src/hooks/useTxToast.ts` — new. Exports `lastTxAtom` (Jotai), the `useTxToast({ explorerUrl? })` hook returning `{ notifyTxPending(label), notifyTxSubmitted(handle, hash), notifyTxConfirmed(handle, successMessage?), notifyTxFailed(handle, error) }`, plus `LastTx`/`LastTxStatus`/`TxToastHandle` types. Each transition writes to `lastTxAtom` so the chip can follow along. Toasts use a single sonner `id` (from the returned handle) so `toast.loading` → `toast.success`/`toast.error` update the same toast instead of stacking.
- `crowdfund-ui/packages/shared/src/components/CrowdfundToaster.tsx` — new. Sonner `Toaster` wrapped with themed classNames (`!bg-card`, `!border-border`, per-level `!border-success/40` / `!border-destructive/40` / etc). Position bottom-right, `expand`, `visibleToasts=5`. No `richColors` — explicit control via classNames. Pattern borrowed from `usdc-v2-frontend/src/components/layout/ToastContainer.tsx`.
- `crowdfund-ui/packages/shared/src/components/LastTxChip.tsx` — new. Reads `lastTxAtom`; renders shadcn `<Button variant="ghost" size="sm">` with a lucide status icon (`Loader2`/`CircleDashed`/`CheckCircle2`/`XCircle`) + truncated hash. Click opens a `<Popover>` with the full label, explorer link (if available), error text (if any), and a Dismiss button that nulls the atom. Returns `null` when `lastTxAtom` is empty.
- `crowdfund-ui/packages/shared/package.json` — added `sonner ^2.0.7` to `dependencies` (not peer — matches the pattern for ethers/lucide-react already in shared).
- `crowdfund-ui/packages/shared/src/index.ts` — barrel additions: `CrowdfundToaster`, `LastTxChip`, `lastTxAtom`, `useTxToast`, and types `LastTx`, `LastTxStatus`, `UseTxToastOptions`, `UseTxToastResult`, `TxToastHandle`.
- `crowdfund-ui/packages/committer/src/hooks/useTransactionFlow.ts` — **breaking API change**. New signature: `useTransactionFlow(signer, { explorerUrl? })` and `execute(label, fn, options?: { successMessage? })`. The hook now drives toasts via `useTxToast` + mirrors each transition into `lastTxAtom`. It still returns `{ state, execute, reset }` so existing disable-button logic keying on `state.status === 'pending'|'submitted'` keeps working.
- Call-site migrations: `CommitTab` (approval + per-hop commit), `InviteTab` (direct invite + self-invite), `useInviteLinks` (revoke), `ClaimTab` (claim ARM + claim USDC refund), `InviteLinkRedemption` (approval + `commitWithInvite`). Each call now passes a descriptive label (e.g. `` `Commit ${formatUsdc(amount)} at ${hopLabel(hop)}` ``, `Claim ARM`, `Revoke invite link`). All inline `<TransactionFlow>` renders removed.
- `crowdfund-ui/packages/committer/src/components/TransactionFlow.tsx` — **deleted**. Per user decision #2, not kept dormant.
- `crowdfund-ui/packages/committer/src/hooks/useInviteLinks.ts` — dropped `revokeTx` from `UseInviteLinksResult` (the panel no longer surfaces it; toasts drive feedback). Updated `InviteTab.test.tsx` mock accordingly.
- `crowdfund-ui/packages/committer/src/App.tsx` — `<LastTxChip />` added to both `headerRight` (replacing a Phase 3 TODO placeholder) and the mobile menu (stacked under ConnectButton). Observer + admin don't get the chip (user decision #3 — committer-only).
- `crowdfund-ui/packages/committer/src/main.tsx` + `observer/src/main.tsx` — swapped bare `<Toaster richColors />` for `<CrowdfundToaster />`. Admin left untouched (out of scope).

**Deviations from plan:**
- **Toaster mount location.** Plan said "mount `<Toaster />` at AppShell level". The `/invite` route (`InviteLinkRedemption`) renders *outside* `<AppShell>`, so strictly mounting inside AppShell would have left that route without toasts. Kept the mount in each app's `main.tsx` (outside `<BrowserRouter>`) but replaced the bare sonner `<Toaster>` with the shared `<CrowdfundToaster>`. Still "shared, themed, bootstrap-level" — just not literally a child of `<AppShell>`. Flagged to the user; they can redirect if strict AppShell-mounting is needed.
- **`TransactionFlow` component deleted outright** rather than kept for "multi-step flows" as the plan suggested. Per user decision: toasts are sufficient; if a future phase needs a full panel it can be reintroduced deliberately.
- **Last-tx chip scope**: committer-only (user decision). Observer has no wallet and no tx lifecycle to surface.
- **Tests skipped** with explicit user waiver for this phase — sonner notification wrappers, the Jotai atom, and the chip are trivial glue. The `useTxToast` state-transition contract could get a focused test if we want belt-and-braces later.
- **Manual smoke testing** against a running local chain was not performed in this phase. Validation was build-based: all three `vite build` green; observer `tsc -b` clean; shared/committer/admin `tsc -b` at pre-existing #259 baseline with zero new errors. Committer vitest run shows only the pre-existing `useProRataEstimate.test.ts` failures (same as #259).

**Pre-existing issues NOT addressed in Phase 4** (still tracked in #259):
- `committer/src/App.tsx` unused `walletENS` local.
- `committer/src/components/CommitTab.tsx` unused `HOP_CONFIGS` import.
- `committer/src/components/InviteLinkRedemption.tsx` unused `isConnected` destructure (my Phase 4 change also removed the now-unused `mapRevertToMessage` import — the mapping still happens inside `useTransactionFlow` — but did **not** touch `isConnected`).
- Test files' pre-existing type errors (ClaimTab, InviteLinkRedemption, useProRataEstimate, wagmiAdapter, admin useRole).

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

**Status:** ✅ Landed on `iskay/crowdfund-ui-polish` (commits `20be45e` · `5be643c` · `474f65e` · `27da98e` · `9b39833`).
**Effort:** ~1–1.5 days
**Depends on:** Phase 2, 3, 4

**Actuals (as shipped):**

Landed as five commits on the umbrella, one per pre-agreed decision seam. The pre-flight §5 targets landed as planned with only the scope trims noted below.

- **5.1 Badge domain variants + pill swap** (`20be45e`). `crowdfund-ui/packages/shared/src/components/ui/badge.tsx` — `badgeVariants` extended with 9 new variants keyed on Phase 1 tokens: `hop-0`, `hop-1`, `hop-2`, `hop-root`, `hop-multi`, `status-pending`, `status-submitted`, `status-confirmed`, `status-failed`. Each uses `bg-<token>/20 text-<token>` except `hop-root` which uses `bg-hop-root/30 text-foreground` (hop-root token is a low-saturation muted grey-blue — 20% tint plus 0.60-lightness text would read poorly on dark background). `crowdfund-ui/packages/committer/src/components/InviteLinkSection.tsx` — inline `statusColors` Record deleted; status pill renders as `<Badge variant={…}>` mapped: pending → `status-submitted`, redeemed → `status-confirmed`, revoked/expired → `outline`. `pending` maps to `status-submitted` rather than `status-pending` because the invite-link "pending" semantic is "signed and outstanding, awaiting redemption" (cyan/blue in the existing palette), not the amber "tx pending" lifecycle state; both tokens happen to resolve to matching colors already but the intent is preserved.

- **5.2 Button migration + linkDestructive CVA** (`5be643c`). `crowdfund-ui/packages/shared/src/components/ui/button.tsx` — `buttonVariants` extended with `linkDestructive: "text-destructive underline-offset-4 hover:underline"` for the Revoke row action. 16 raw `<button>` call sites replaced with shadcn `<Button>` across CommitTab (MAX → `secondary size=sm`; Review Commitment / Back / Approve & Commit), ClaimTab (Claim Refund ×2; Claim ARM), InviteTab (Self-invite → `secondary size=xs`; Send Invite), InviteLinkSection (Create → `default size=sm`; Create All → `outline size=sm`; Copy → `link size=sm h-auto p-0 text-[10px]`; Revoke → `linkDestructive size=sm h-auto p-0 text-[10px]`), InviteLinkRedemption (Connect Wallet; MAX → `link size=sm h-auto p-0 text-xs`; Approve & Join). The Phase 4 disable pattern (`tx.state.status === 'pending' || 'submitted'`) flows through the primitive's `disabled` prop unchanged on all 5 tx-driven sites. RainbowKit `<ConnectButton>` left in place per scope.

- **5.3 Input migration** (`474f65e`). 4 raw `<input>` elements swapped for shadcn `<Input>` in CommitTab (per-hop amount, `inputMode="decimal"`), InviteTab (address / ENS), InviteLinkRedemption (redemption amount), DelegateInput (delegate address). Per-site typography preserved via className overrides (`text-sm`, `text-xs`, `font-mono`). In InviteLinkRedemption the existing `<label>` element was upgraded to shadcn `<Label>` with an `htmlFor="invite-redeem-amount"` binding, overriding the Label default (`text-sm font-medium`) with `text-xs font-normal text-muted-foreground` to match the prior visual. No new labels were added where the current UI had none — preserving the "straight 1:1 swap" intent from the plan; a unified `<AmountInput>` compound with proper labelling is Phase 8 scope.

- **5.4 Tabs line variant + ToggleGroup segmented controls** (`27da98e`). Installed `toggle-group` via `npm_config_legacy_peer_deps=true npx shadcn@latest add toggle-group` from `packages/shared/`, applied the post-processing steps from `shared/CLAUDE.md` (moved out of `./@/components/ui/`, relative imports with `.js` extensions, stripped `"use client"`, `ABOUTME` headers, barrel exports `Toggle`, `toggleVariants`, `ToggleGroup`, `ToggleGroupItem`). Shipping `toggle.tsx` alongside `toggle-group.tsx` because the primitive depends on it (`toggleVariants` from `./toggle.js`). Re-coloured the existing Tabs `line` variant indicator from `after:bg-foreground` → `after:bg-primary` so active underlines read as brand accent rather than plain white. Tabs conversions (3 bars): observer `App.tsx:300` Tree/Table mobile, committer `App.tsx:275` network/participate mobile, committer `App.tsx:333` commit/invite/claim action header with per-trigger `disabled={!tabStates[tab].enabled}`. ToggleGroup conversions (4 segmented controls): CommitTab approve exact/unlimited; InviteTab and InviteLinkSection dynamic hop selectors; DelegateInput self/custom. Each `onValueChange` guards against Radix's empty-string emission on active-trigger re-click so state can't get stuck un-selected. Active-item styling preserved via `data-[state=on]:bg-primary data-[state=on]:text-primary-foreground` className overrides (ToggleGroup's default active styling is `bg-accent text-accent-foreground` which reads as a hover glow rather than an asserted selection). Post-commit lint passes: `rg '<button ' crowdfund-ui/packages/{observer,committer}/src` → zero hits; `rg '<input ' crowdfund-ui/packages/{observer,committer}/src` → zero hits.

- **5.5 Info tooltips + TOOLTIPS glossary** (`9b39833`). New `crowdfund-ui/packages/shared/src/lib/tooltips.ts` — `TOOLTIPS` Record keyed by `hop | slot | proRata | allocation | delegate`, plus `TooltipKey` type. New `crowdfund-ui/packages/shared/src/components/InfoTooltip.tsx` — shadcn Tooltip wrapped with a lucide `Info size={14}` button trigger, 150ms `delayDuration`. Each InfoTooltip mounts its own `<TooltipProvider>` (minor duplication cost for <15 instances) so no app-bootstrap edit is required and the `/invite` route — which renders `InviteLinkRedemption.tsx` outside `<AppShell>` — still gets working tooltips. Barrel-exported `InfoTooltip`, `InfoTooltipProps`, `TOOLTIPS`, `TooltipKey`. Placed 9 info icons across 6 components: CommitTab (Hop in "Your positions"), InviteTab (Slot + Hop in "Your Invite Slots"), ClaimTab (Allocation in "Settlement Breakdown"), DelegateInput (Delegate in label), ProRataEstimate (Allocation + Pro-rata in "Estimated Allocation"), InviteLinkRedemption (Hop on Position row + Slot on Invite slots row).

**Deviations from plan:**

- **Info-tooltip count: 9, not 11.** The plan file budgeted ~11. Dropped 2: (a) no dedicated tooltip in CommitTab for Pro-rata / Allocation because `ProRataEstimate` is rendered as a child of CommitTab on both the input and review steps, so placing those tooltips inside `ProRataEstimate` reaches CommitTab users transitively without duplication; (b) no tooltip in `InviteLinkSection` because its invite-slot context is identical to `InviteTab`'s and they share a screen. Judgment call per decision P5-D3 ("one per term per component, judgment-call based on whether the reader has already seen the tooltip upstream").

- **TooltipProvider scope.** Plan file said "add `TooltipProvider` to AppShell" as the cleanest option. Landed with per-component providers baked into `InfoTooltip` instead. AppShell-level would have required a parallel addition for the `/invite` route (standalone, not wrapped by AppShell). Self-contained was a lighter change. If many more tooltips land in Phase 6+, consider promoting to a single root-level provider.

- **Tabs primitive already shipped with `line` variant.** Plan file expected to author the variant. Phase 2's shadcn install brought it in already; Phase 5.4 only needed to re-colour `after:bg-foreground` → `after:bg-primary` to match brand accent. Saved ~30 lines of CVA authoring.

- **ToggleGroup install added Toggle dependency.** `toggle-group.tsx` imports `toggleVariants` from `./toggle.js`. Both files ship together; can't install one without the other via shadcn CLI. Both barrel-exported for future use even though only ToggleGroup is consumed today.

- **`data-[state=on]` active-style override on every ToggleGroupItem.** The shadcn-shipped `toggleVariants` default active treatment is `bg-accent text-accent-foreground` (hover-style), which reads as a passive glow rather than a selected pill. Each of the 7 segmented-control ToggleGroupItems passes a className with `data-[state=on]:bg-primary data-[state=on]:text-primary-foreground` to restore the existing committer visual of a solid accent fill on the active item. If a future phase revisits this, consider editing `toggleVariants` in place rather than override per call site.

- **Package-lock.json normalization.** The shadcn `toggle-group` install re-synced the lock file, adding entries for `@testing-library/dom`, `@testing-library/react`, and `sonner` that were previously present in workspace `package.json` manifests but missing from the lock (carry-over inconsistencies from earlier phases). Rolled into Commit 5.4 since it's incidental to the install.

- **Tests skipped** with explicit user waiver for the phase ("proceed to implement" after test ask; treated as per-phase waiver). Validation was build-based: all three `vite build` green across 5 commits; observer `tsc -b` clean; shared / committer `tsc -b` at pre-existing #259 baseline with zero new errors. Every raw `<button>` and `<input>` tag in scope removed; no functional regression expected from primitive swaps.

- **Manual smoke testing against running local chain was not performed in this phase.** Validation was build + type + lint only. Recommended before merging the umbrella → main.

**Pre-existing issues NOT addressed in Phase 5** (tracked in #259):

- `committer/src/App.tsx` unused `walletENS` local.
- `committer/src/components/CommitTab.tsx` unused `HOP_CONFIGS` import.
- `committer/src/components/InviteLinkRedemption.tsx` unused `isConnected` destructure.
- Shared test files (`useAllocations.test.ts`, `rpc.test.ts`) — unused imports + type mismatch.
- Committer test files (`ClaimTab.test.tsx`, `InviteLinkRedemption.test.tsx`, `InviteTab.test.tsx`, `useProRataEstimate.test.ts`) — unused imports + type mismatches.
- `committer/src/lib/wagmiAdapter.ts` strict-null issue.
- Admin `useRole.test.ts` missing test-runner type definitions.



**Pre-flight for the Phase 5 agent (read before writing code):**

1. **What's already available from shared (Phase 2 output).** All shadcn primitives are re-exported from `@armada/crowdfund-shared` — `Button`, `Input`, `Label`, `Card`, `Dialog`, `Tooltip`, `Tabs`, `Select`, `Separator`, `Skeleton`, `Alert`, `ScrollArea`, `Popover`, `Sheet`, `Badge`. `cn()` is also there. **Do not run `shadcn add` for any of these** — they're installed. The installation lives only in `packages/shared/src/components/ui/`; per-app `components.json` files were deleted. If you need a new primitive (e.g. `RadioGroup`, `Checkbox`, `Progress`), run it from `packages/shared/` following the regeneration workflow documented in `packages/shared/CLAUDE.md` (`npm_config_legacy_peer_deps=true npx shadcn@latest add …`, then move files out of the stray `./@/` dir, rewrite `@/` imports to relative `.js`, strip `"use client"`, prepend ABOUTME header, barrel-export).

2. **Transaction UX is already migrated.** Phase 4 deleted `packages/committer/src/components/TransactionFlow.tsx`. Every commit/invite/claim/revoke/redemption flow now drives toasts via `useTransactionFlow(signer, { explorerUrl })` → `tx.execute(label, fn)`. Don't look for TransactionFlow; don't reintroduce a panel. The disable-button pattern used across ClaimTab, CommitTab, InviteLinkRedemption is `tx.state.status === 'pending' || tx.state.status === 'submitted'` — preserve that when swapping plain `<button>` for shadcn `<Button>` (use the `disabled` prop).

3. **Three mobile tab bar implementations** (plan task #2) — confirmed locations:
   - `crowdfund-ui/packages/committer/src/App.tsx` — top-of-page `MobileTab` toggle (`'network' | 'participate'`).
   - `crowdfund-ui/packages/committer/src/components/CommitTab.tsx` — per-hop amount step toggle and the "Approve exact / unlimited" segmented control.
   - `crowdfund-ui/packages/committer/src/components/InviteTab.tsx` + `InviteLinkSection.tsx` — hop selector buttons.
   Consolidate where it makes sense; keep in mind that not every segmented control is the same shape as `<Tabs>` (some are filter pills, some are single-choice). Use `<Tabs>` for genuine page-level navigation; use shadcn `<ToggleGroup>` (install if needed) or styled `<Button>` group for segmented inputs.

4. **Button audit targets.** Grep `rg -n '<button ' crowdfund-ui/packages/observer/src crowdfund-ui/packages/committer/src` to enumerate. Known hotspots: CommitTab (Review Commitment, Back, Approve & Commit, MAX, segmented approve controls), InviteTab (Send Invite, Self), InviteLinkSection (Create/Create All, per-row Copy/Revoke), ClaimTab (Claim ARM, Claim Refund), InviteLinkRedemption (Connect Wallet, Approve & Join, MAX), and the app `<ConnectButton>` wrapper stays as-is (it's RainbowKit's; don't replace).

5. **Input audit targets.** Fewer: address input in InviteTab, amount input in CommitTab + InviteLinkRedemption, delegate address in `DelegateInput.tsx`, USDC amount in CommitTab per-hop, `SearchBar` in shared (uses its own Input already?). Verify.

6. **Badge variants — plan explicitly authorizes extending CVA in place.** The Phase 1 tokens expose `bg-hop-0..2`, `bg-hop-root`, `bg-hop-multi`, `bg-status-pending|submitted|confirmed|failed`, `bg-success/error/warning/info`. Extend `packages/shared/src/components/ui/badge.tsx`'s `badgeVariants` directly. Don't wrap `<Badge>` in an app-local component.

7. **Icon-info tooltips.** Domain terms to annotate per plan: "hop", "pro-rata", "invite slot", "allocation", "delegation" (ARM claim). Use lucide `Info` at `size={14}`, wrap in shadcn `<Tooltip>`. Glossary text source: §9 of this doc.

8. **Out of scope for Phase 5 (don't touch):**
   - Skeleton loaders, empty states, error boundaries → Phase 6.
   - Inline red/amber warning divs (`balanceInsufficient`, "Below Minimum Raise", "Canceled", "Floor not yet filled") → those are Phase 6 `<ErrorAlert>` / empty-state scope.
   - Form validation rewrites → Phase 8.
   - Admin app.
   - The pre-existing #259 baseline errors (CommitTab unused `HOP_CONFIGS`, App.tsx unused `walletENS`, etc.) — don't fix inside Phase 5.

9. **Validation gates.** Must stay green: `npx vite build` in observer, committer, admin. `npx tsc -b` in observer (clean). Shared/committer/admin `tsc -b` must stay at #259 baseline (no new errors added). Committer `vitest run` — the 6 pre-existing `useProRataEstimate.test.ts` failures are baseline; any other failures are regressions introduced by the phase.

10. **Branch + commit rule.** Check out `iskay/crowdfund-ui-polish` directly. No feature branches. One or two commits; don't open a PR to main. Landing decision is deferred until every phase has landed.

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
- **Mobile smoke test** at ≥375px viewport — no horizontal scroll, tabs/segmented controls tap targets ≥40px.

---

### Phase 6 — Skeletons, empty states, error boundaries

**Status:** ✅ Landed on `iskay/crowdfund-ui-polish` (commits `12b19f1` · `7668ad3` · `d828549` · `367752a`).
**Effort:** ~1 day
**Depends on:** Phase 2 (Skeleton, Alert primitives installed), Phase 5 (Button/Input/Tabs migration complete so error/empty chrome lives on top of a consistent baseline).

**Actuals (as shipped):**

Landed as four commits, one per sub-goal:

- **6.1 ErrorAlert + alertVariants.warning + panel swaps** (`12b19f1`). Extended `shared/components/ui/alert.tsx` `alertVariants` CVA: `destructive` now carries tinted border+bg (`border-destructive/50 bg-destructive/10 text-destructive`) matching the existing grammar rather than the shadcn default (`bg-card`); added `warning` variant on the same shape backed by the `--warning` Phase-1 token. New `shared/components/ErrorAlert.tsx` wraps `<Alert>` as `{ title?, children, icon?, variant? }`, defaults to `<AlertTriangle/>` icon + `destructive` variant, accepts `icon={false}` to suppress. Swapped 6 destructive block panels (observer App deployment error + "Crowdfund Cancelled", committer App wallet error, InviteLinkRedemption expired + pre-check error, ClaimTab canceled refund banner) and 4 amber block panels to `variant="warning"` (observer App Refund Mode, ClaimTab Below Minimum Raise + refund-mode notice + ARM claim deadline passed). InviteTab duplicate-invite hint (`p-2 text-xs`, `border-amber-500/30`, `bg-amber-500/5`) left inline — subtle sub-field warning, not a block panel (per P6-D1.a). 4 inline `text-destructive` field-validation sites in DelegateInput / CommitTab / InviteTab / InviteLinkRedemption stay inline. Admin app untouched.

- **6.2 EmptyState + call-site swaps** (`7668ad3`). New `shared/components/EmptyState.tsx` with API `{ icon: LucideIcon, title, description?, action?, className? }`. Renders a centered column: muted rounded-tile icon, foreground-weight title, muted description, optional action slot. Barrel-exported. Swapped 5 call sites: `TableView.tsx` empty `<td>` now renders EmptyState with `Search` or `Users` icon (filter-aware), InviteTab "No Invite Slots Available" → `Ticket`, CommitTab "Not Eligible" → `ShieldOff`, committer wallet-gate card → `Wallet` + RainbowKit `<ConnectButton/>` in the `action` slot (preserving outer `rounded-lg border bg-card` chrome), ClaimTab `armAmount === 0 && refundAmount === 0` case short-circuits to `Inbox` EmptyState (removes both the trailing inline "No allocation found" note and the zeroed breakdown rows that would have rendered alongside it). Terminal-success screens (e.g. "All Claims Complete") intentionally left bespoke per pre-flight.

- **6.3 Skeleton placeholders** (`d828549`). Added `isLoading?: boolean` prop to `StatsBar`, `TableView`, `TreeView`. When `isLoading && <zero-data>`, each component renders skeleton chrome instead of the live or empty render: StatsBar uses a `StatsBarSkeleton` internal helper mirroring the real layout (badge + top-row stats + 3-tile hop grid + aggregate row); TableView renders 5 skeleton `<tr>` rows with one `<Skeleton>` per column (the EmptyState cell still kicks in once loading resolves to zero rows); TreeView renders a centered pulsing grey circle inside the standard bordered container, falling through to the existing "Waiting for seeds..." panel once loading completes without data. Wired from each app's `useContractEvents({...}).loading` as `isLoading={eventsLoading}` at every render site (observer: 2 StatsBar + 2 TreeView + 1 TableView; committer: 1 of each). LastTxChip spinners unchanged (ongoing-activity, not loading chrome). InviteTab "Resolving ENS name..." text left as plain text to preserve conditional-rendering chain.

- **6.4 ErrorBoundary at app root + major panels** (`367752a`). New `shared/components/ErrorBoundary.tsx` — classic class component with `getDerivedStateFromError` + `componentDidCatch`, `console.error`s the caught error so it survives, exposes a `reset` callback. Accepts `fallback` (ReactNode or render-prop `(error, reset) => ReactNode`), defaulting to `<DefaultErrorFallback>` — a destructive `<Alert>` with "Try again" (calls reset) and "Reload page" (`window.location.reload()`) buttons. Wrapped two granularities in each app: an outer boundary around the main render path *inside* `<AppShell>`'s children (shell chrome still renders on fatal error), plus per-panel boundaries around StatsBar, TreeView, TableView, and — committer-only — the action panel (wallet-gate / Commit/Invite/Claim tab container). Admin untouched. Observer fallback/pre-open/loading screens intentionally unwrapped (static, unlikely to throw).

**Deviations from plan:**

- **Alert CVA destructive default replaced.** Plan implied tuning would be additive (add `warning`); the shadcn-shipped `destructive` variant (`bg-card text-destructive`) was too muted versus the existing `bg-destructive/10` grammar used across 6 call sites, so `destructive` was also tuned to tinted border+bg. No existing `<Alert variant="destructive">` consumers existed outside the primitive (checked with grep), so nothing regressed.
- **ClaimTab no-allocation site restructured rather than swapped.** Pre-flight targeted a 1-line swap at `ClaimTab.tsx:365`. Replacing that inline note alone would have left the surrounding post-finalization render showing a zeroed-out breakdown *plus* an EmptyState — redundant information twice. Instead, short-circuited the whole branch to EmptyState when `armAmount === 0 && refundAmount === 0`. Cleaner result, one extra early return, same net intent.
- **Amber block-panel count: 4, not 5.** Pre-flight estimated "~5 sites". Final audit found 4 block panels using `border-amber-500/50 bg-amber-500/10` in scope (observer App:277 + ClaimTab:153/236/263). The remaining amber site (InviteTab:268 duplicate-invite hint) uses `border-amber-500/30 bg-amber-500/5 p-2 text-xs` — clearly sub-field inline hint, not a block. Left inline per P6-D1.a.
- **`icon={false}` escape hatch on ErrorAlert.** Not called for in pre-flight, added defensively so consumers can suppress the default `<AlertTriangle/>` without needing a wrapper component. No current consumer uses it.
- **DefaultErrorFallback exports two actions** — "Try again" (calls the boundary's internal `reset` so retry re-mounts children) and "Reload page" (nukes the process). Pre-flight only asked for "a reload button"; adding reset is a cheap ergonomic bonus since the boundary's `reset` was already wired.
- **Root ErrorBoundary placed inside AppShell, not outside.** Matches pre-flight spec ("a fatal error still renders the shell"). Mechanically: the wrap brackets the main render path's `<div className="container ...">`; AppShell and its own chrome sit outside the boundary.
- **Tests skipped** with explicit user waiver ("add tests if and only if they provide meaningful value, otherwise skip them"). Judgement call: the three new components are glue (alert chrome, static centered layout, standard class-component boundary) — a focused test of `ErrorBoundary`'s rethrow/fallback contract has *some* value but the class-component pattern is well-known and the payoff is low. Skipped for now; easy to add later if it pays off.
- **Manual smoke** deferred to the user (per their explicit answer). Validation was build-based across all four commits: all three `vite build` green; observer `tsc -b` clean; shared + committer `tsc -b` at pre-existing #259 baseline with zero new errors introduced; `rg '(bg|border)-destructive/[0-9]+' crowdfund-ui/packages/{observer,committer}/src` shows only the 4 inline `text-destructive` field-validation sites remain + `LastTxChip` tx-error sub-panel (intentional).

**Pre-existing issues NOT addressed in Phase 6** (still tracked in #259):
- `committer/src/App.tsx` unused `walletENS` local (now at line 185 after the Phase 6 edits).
- `committer/src/components/CommitTab.tsx` unused `HOP_CONFIGS` import.
- `committer/src/components/InviteLinkRedemption.tsx` unused `isConnected` destructure.
- Shared test files (`useAllocations.test.ts`, `rpc.test.ts`) — unused imports + type mismatch.
- Committer test files (`ClaimTab.test.tsx`, `InviteLinkRedemption.test.tsx`, `InviteTab.test.tsx`, `useProRataEstimate.test.ts`) — unused imports + type mismatches.
- `committer/src/lib/wagmiAdapter.ts` strict-null issue.
- Admin `useRole.test.ts` missing test-runner type definitions.

**Pre-flight for the Phase 6 agent (read before writing code):**

1. **Primitives are ready.** `Skeleton`, `Alert`, `AlertTitle`, `AlertDescription` are already barrel-exported from `@armada/crowdfund-shared` (see `packages/shared/src/index.ts`). Do not re-install. If you need a variant Alert ships without (e.g. `warning`, `info`), extend `alertVariants` CVA in place in `packages/shared/src/components/ui/alert.tsx` rather than wrapping.

2. **No existing ErrorBoundary anywhere.** `componentDidCatch` / `getDerivedStateFromError` search returns zero hits in observer, committer, and shared. Greenfield — you are adding the first one. Plan ships it at `packages/shared/src/components/ErrorBoundary.tsx`.

3. **Concrete inline-error hotspots to unify under `<ErrorAlert>` (destructive block panels, 6 sites):**
   - `observer/src/App.tsx:260` — deployment/state error panel.
   - `observer/src/App.tsx:267` — "Crowdfund Cancelled" full panel.
   - `committer/src/App.tsx:258` — deployment/state error panel.
   - `committer/src/components/InviteLinkRedemption.tsx:303` — invalid link / precondition failure.
   - `committer/src/components/InviteLinkRedemption.tsx:309` — link expired or revoked.
   - `committer/src/components/ClaimTab.tsx:215` — claim failure or precondition.

   Inline `text-destructive` validation errors (not block-level, just red text next to a field) are a judgement call. My recommendation: **leave them as inline text**, don't wrap in `<Alert>`. Hit sites: `DelegateInput.tsx:57`, `CommitTab.tsx:383`, `InviteTab.tsx:262`, `InviteLinkRedemption.tsx:367`. An Alert around each field-level error is visual noise.

4. **Amber/warning blocks — decision to lock (P6-D1):** 12 amber-color sites exist across CommitTab, InviteTab, InviteLinkSection, InviteLinkRedemption, ProRataEstimate, ClaimTab, and observer `App.tsx:277`. Some are block panels (`border-amber-500/50 bg-amber-500/10` — "Refund Mode", "Below Minimum Raise", "Crowdfund was canceled", "duplicate invite already issued") and some are inline `text-amber-500` warning lines. Two paths:
   - **P6-D1.a** Add a `warning` variant to `alertVariants` CVA and promote only the block panels (5 sites). Leave the inline amber text alone — those are sub-field warnings, not alert-worthy.
   - **P6-D1.b** Leave amber alone entirely this phase; do only the 6 destructive ones. Amber → Alert can come later.
   
   Recommendation: **P6-D1.a.** Consistent treatment of "here is a block-level heads-up you need to read" is the whole point of ErrorAlert. Inline warnings stay inline.

5. **Skeleton targets and hazards:**
   - **StatsBar** renders empty stat cards when `hopStats.length === 0` (see `packages/shared/src/components/StatsBar.tsx`). Wrap the whole bar in `<Skeleton>` during the initial `useContractEvents` fetch; do not try to skeletonise each stat tile individually.
   - **TableView** has a built-in empty-state cell at `packages/shared/src/components/TableView.tsx:404–413` ("No participants yet" / "No matching participants"). For loading, render ~5 skeleton `<tr>` rows inside the `<tbody>`; for empty, promote the existing plain-text cell to the new shared `<EmptyState>` with a lucide icon (e.g. `Users` or `Search`).
   - **TreeView** always renders a ROOT node even with an empty graph; no visible "blank" state. Skeleton for TreeView should be a centered pulsing placeholder during the first load, then swap to the real canvas. Keep the hand-off atomic — don't blink between skeleton and rendered tree while d3-hierarchy mounts.
   - **Transactional spinners** (LastTxChip uses `Loader2` + `CircleDashed` with `animate-spin`) — these are **not Skeleton candidates.** They're ongoing-activity indicators, not data-loading placeholders. Leave them.
   - **Dependent render hazard:** `InviteTab.tsx:253–254` has `{resolving && (<div>Resolving ENS name...</div>)}` that gates subsequent conditional renders of the resolved address. A naïve swap to `<Skeleton>` would lose the visibility toggle chaining. Either keep the text "Resolving ENS name..." (acceptable — it's inline status, not a data-load skeleton) or replace with `<Skeleton className="h-3 w-32" />` but preserve the surrounding conditionals.

6. **Empty-state targets (create `packages/shared/src/components/EmptyState.tsx`):** Each takes `{ icon, title, description?, action? }` per the plan task list. Call sites that should be promoted to it:
   - `TableView.tsx:404–413` — "No participants yet" / "No matching participants" (the current plain-text cell).
   - `InviteTab.tsx:162` — "No Invite Slots Available" center block.
   - `ClaimTab.tsx:365` — "No allocation found for this address." center block.
   - `ClaimTab.tsx:192–207` (already-claimed "All Claims Complete" panel) — debatable. My recommendation: **leave it alone.** It's a terminal-success screen, not an empty state; the plan says EmptyState is for "absence of data", not "workflow complete".
   - `CommitTab.tsx:232–238` — "Not Eligible" center block. Good EmptyState candidate.
   - `committer App.tsx:327–331` — "Connect your wallet to participate" with `<ConnectButton/>`. Good EmptyState candidate with a primary action slot.
   
   StatsBar and TreeView do **not** need empty states — they handle zero-data gracefully (StatsBar shows empty tiles; TreeView shows a lonely ROOT node). Data-layer concerns, not empty-state concerns.

7. **ErrorBoundary placement:**
   - App root, once per app (observer + committer, admin optional). Catches fatal errors; shows "Something went wrong" card with a reload button.
   - Per-panel wrappers on observer's tree, table, and stats; committer's same plus its action panel. Isolates one failing panel from blanking the whole page.
   - Shared implementation in `packages/shared/src/components/ErrorBoundary.tsx` — use the classic class-component pattern (`componentDidCatch`, `getDerivedStateFromError`). Export a `<ErrorBoundary fallback={...}>` + a default `<DefaultErrorFallback>` card built on shadcn `<Alert variant="destructive">` + a `<Button onClick={() => window.location.reload()}>Reload</Button>`.
   - **Do not** add error boundary around individual rows or small widgets — the plan says "each major panel", not "every component".

8. **Phase 5 deviations Phase 6 should be aware of:**
   - **Per-component `TooltipProvider`** — each `InfoTooltip` instance from Phase 5.5 mounts its own provider. If Phase 6 introduces >5 more tooltips, consider promoting to a single provider at AppShell. Otherwise stick with the per-component pattern — it keeps the `/invite` route (outside AppShell) working without bootstrap edits.
   - **ToggleGroup active-style override** — each `<ToggleGroupItem>` from Phase 5.4 carries `data-[state=on]:bg-primary data-[state=on]:text-primary-foreground` className because the shipped `toggleVariants` active-state is `bg-accent` which reads as a hover glow. If Phase 6 touches these call sites (it probably won't), preserve the pattern or promote it into `toggleVariants` in place.
   - **Tabs `line` variant recoloured.** Active tab underline is `after:bg-primary` (brand cyan). No impact on Phase 6 but worth knowing for visual consistency when you design Alert colors.
   - **Badge CVA extended with 9 domain variants** (`hop-*`, `status-*`) — Phase 6's ErrorAlert should not reproduce status-pill semantics in block Alerts. Alert = panel/block; Badge = inline pill. Don't blur them.
   - **Manual browser smoke not yet performed on Phase 5.** Phase 6 agent should run the local stack once (`npm run chains && npm run setup && npm run armada-relayer && npm run crowdfund:observer` + `crowdfund:committer`) and at minimum connect a wallet, try a commit, and hit a claim/invite flow — verifying Phase 5 didn't quietly break anything before stacking Phase 6 on top.
   - **Validation baseline:** `npx tsc -b` in observer is clean; shared/committer/admin sit at pre-existing #259 baseline (unused `walletENS`, `HOP_CONFIGS`, assorted test file type errors). Phase 6 must not introduce *new* errors but should not attempt to fix baseline either.

9. **Out of scope for Phase 6 (don't touch):**
   - Inline red validation text next to form fields (judgement call above — leave inline).
   - Success messages like "All positions filled", "All Claims Complete" (workflow terminations, not empty/error states).
   - TanStack Query integration — that's Phase 7, which *depends on* Phase 6's error boundaries catching query failures.
   - React error boundary on individual rows/widgets.
   - LastTxChip spinners (ongoing-activity, not loading chrome).
   - Admin app (D7).
   - Pre-existing #259 baseline errors.
   - Phase 1 `theme.css` token values.

10. **Commit granularity suggestion (four commits seems natural):**
    - 6.1 — shared `<ErrorAlert>` component + optional `alertVariants.warning` (per P6-D1) + swap the 6 destructive block panels + 5 amber block panels (if D1.a).
    - 6.2 — shared `<EmptyState>` component + swap the 5 call sites listed above (TableView cell, InviteTab/ClaimTab/CommitTab center blocks, committer wallet-gate).
    - 6.3 — Skeleton placeholders for StatsBar/TableView/TreeView initial loads.
    - 6.4 — `ErrorBoundary` at app root + major panels.

11. **Validation gates (same pattern as Phase 5):**
    - `npx vite build` in observer + committer + admin, all green.
    - `npx tsc -b` in observer clean; shared/committer/admin at #259 baseline (no new errors).
    - `npx vitest run` in committer — only `useProRataEstimate.test.ts` failures expected (baseline).
    - `rg '(bg|border)-destructive/[0-9]+' crowdfund-ui/packages/{observer,committer}/src` — only the 4 inline `text-destructive` sites from item 3 should remain (block panels all migrated to ErrorAlert).
    - Mobile smoke at 375px — ErrorAlert doesn't horizontally overflow; Skeletons match their target component's width.
    - Manual smoke: disconnect the RPC in DevTools mid-session → error boundary should surface, not a blank screen.

**Tasks (from original plan, unchanged — pre-flight above grounds each):**

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

**Effort:** spike 0.5 day, polish 1.5–2 days
**Depends on:** Phase 1 (for theme tokens)

The spike is the exception to the "no feature branches" rule in §0: create a temporary `iskay/crowdfund-ui-graph-spike` branch for the A/B, then **discard it** once the comparison is done. Only the winning approach lands on the umbrella as a commit.

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

## 6. Total effort & rough order-of-merge

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

## 7. How future agents should use this doc

- **Start of a new session:** read this file end-to-end plus CLAUDE.md.
- **Branch rule:** check out `iskay/crowdfund-ui-polish` and commit onto it directly. No per-phase feature branches. No PRs to `main` during the polish pass. See §0.
- **Before picking up a phase:** read `git log iskay/crowdfund-ui-polish` to see which phases have already landed. Ask the user which phase to tackle if unclear.
- **Mark progress here:** when a phase lands, update its Status line to `✅ Landed on \`iskay/crowdfund-ui-polish\` (commit \`<sha>\`)` and fill in the Actuals block. Do not delete phases.
- **If a phase changes in scope:** edit this doc; don't start a parallel one.
- **When all phases have landed:** the user decides when to open the umbrella → main PR (squash vs merge is deferred until then). After that lands, archive this file to `.claude/archive/CROWDFUND_UI_POLISH.md` and add a one-line summary of what was done.

---

## 8. Open questions / things to escalate

- **Brand identity**: token values in Phase 1 are placeholders. When design lands, a single PR should re-value `theme.css`; the token names should remain stable.
- **Graph library choice**: pending Phase 10 spike.
- **Observer ENS/avatars**: committer already resolves ENS via `useENS` — ensure the shared TreeView consumes the same data on observer. Should already work but verify.
- **Accessibility baseline**: we haven't defined a target (AA vs AAA). AA is assumed. Flag if user wants stricter.
- **i18n**: not in scope now. If added later, will need to refactor all string literals — flag early.
- **Admin app**: explicitly out of scope. If a future change to shared breaks admin, fix admin but don't polish it.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **Hop** | Social distance from the initial whitelist (hop 0 = whitelisted, hop 1 = invited by hop 0, hop 2 = invited by hop 1). Caps at hop 2. |
| **Slot** | An invite slot — each participant has a finite number they can pass to invitees. |
| **Pro-rata** | If the crowdfund is oversubscribed at a hop, commitments are scaled down proportionally. |
| **Connected address** | The wallet currently connected in the committer app. Gets visual emphasis in the graph and pinned to top of the table. |
| **Multi-hop** | An address that was invited by participants at more than one hop — rendered once at its lowest hop with a visual marker. |
| **Finalization** | After cap hit and time elapsed, admin calls `finalize()` → commitments become claimable as ARM. |
| **Cancellation** | Admin can cancel → commitments become refundable as USDC. |
