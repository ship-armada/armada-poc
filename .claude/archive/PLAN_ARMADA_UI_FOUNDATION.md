# @armada/ui — Design System Foundation Plan

**Status:** Foundation complete (steps 1–5). Active branch: `iskay/committer-visual-redesign`.

## Goal

Stand up `@armada/ui` as a shared design-system package consumable by:
- The three crowdfund apps (observer, committer, admin) — for incremental visual migration once the designer ships more screens.
- The future `armada-interface` app — which will adopt the new visual language from day one.

Scope of *this* foundation pass is intentionally narrow: tokens, typography, global reset, package scaffolding, and a showcase page. **No screen migration. No primitive porting beyond what the designer has already finished in the mockup.** That work waits for the designer to complete more screens.

## Source of Visual Truth

- **Mockup repo:** `/Volumes/T7/armada-crowdfund` (visual-only, no real functionality).
- **Tokens source:** `src/tokens/armada-tokens.json` — Style-Dictionary-flavored format.
- **Generated CSS:** `src/styles/tokens.css` — labelled "AUTO-GENERATED" but the build script is missing on disk.

## Strategy Decision

**Strategy B confirmed:** CSS Modules + design-token CSS variables. Not Tailwind, not shadcn/ui. Reasons:
- "Implemented exactly" requires lexical scoping (CSS Modules) — Tailwind's `tailwind-merge` precedence and shadcn's CVA defaults are exactly the kind of inherited-class footgun we want to avoid.
- The mockup is already built this way; we adopt its idiom rather than translate.
- For Radix-backed primitives the mockup lacks (Dialog, Select, Tabs, Popover), we will wrap Radix with CSS Modules + tokens when the designer covers them. Not in this foundation pass.

## Package Placement

`packages/ui/` at the repo root, **sibling to** (not nested inside) `crowdfund-ui/packages/`. Rationale:
- Has zero dependency on crowdfund domain logic.
- Must be consumable by `armada-interface` (which will live outside `crowdfund-ui/`).
- Keeps the dependency graph one-way: crowdfund apps depend on both `crowdfund-shared` and `@armada/ui`; `armada-interface` depends only on `@armada/ui`.

This requires adding `"packages/*"` to the root `package.json` workspaces array alongside the existing `crowdfund-ui/packages/*`.

## Deferred — Token Build Pipeline

The mockup's `package.json` references `npx tsx scripts/build-tokens.ts` for regenerating `tokens.css` from `armada-tokens.json`. **The script does not exist on disk** — either lost or never committed by the designer.

**Current decision (Option D):** Treat `tokens.css` as hand-maintained source of truth for now. Keep `armada-tokens.json` alongside as reference. The CSS file's header is updated to reflect this honestly.

**When updating tokens:** edit `tokens.css` directly AND mirror the change in `armada-tokens.json` so the future migration to a generated pipeline is clean.

**Recovery path (future):** Either (a) recover the missing `build-tokens.ts` from the designer, or (b) write a tiny Style Dictionary config. The JSON format is standard Style Dictionary, so option (b) is ~30 minutes of work. Track when designer is reachable.

## Notable observations to keep in mind

- `tokens.css` emits **unitless** values for some token types (e.g. `--primitives-fontSize-xs: 10;` with no `px`). This is how the mockup ships it. Component CSS Modules in the mockup multiply by `px` when consuming. We preserve this verbatim; don't "fix" it.
- Fonts (Geist, Charis SIL) load from Google Fonts CDN. Acceptable for now per Butters; revisit before production.
- No light mode. Single dark theme.

## Step Plan (foundation only)

| # | Step | Status |
|---|------|--------|
| 1 | Investigate mockup token pipeline | ✅ Done — pipeline missing, Option D chosen |
| 2 | Stand up `packages/ui/` skeleton + copy tokens/global.css | ✅ Done |
| 3 | Wire workspace into root `package.json`, verify install | ✅ Done |
| 4 | Port finished mockup primitives (Button, Tag, NavItem, NavBar, Header, BarTrackTicks, Progress) | ✅ Done |
| 5 | Stand up showcase Vite app for pixel-compare (`npm run ui:showcase` → :5180) | ✅ Done |
| ⏸️ | **STOP. Wait for designer.** | |
| later | Screen-by-screen migration of crowdfund apps | blocked on more mockup screens |
| later | Radix-backed primitives (Dialog/Select/Tabs/Popover/Tooltip/Separator) | blocked on mockup designs |
| later | Token build pipeline recovery / Style Dictionary adoption | blocked on designer reachability |

## What is NOT in scope right now

- Replacing `crowdfund-ui/packages/shared/src/styles/theme.css` (the existing Tailwind/oklch theme). It keeps working untouched. Old shadcn primitives continue using it. CSS Modules scoping prevents collisions.
- Removing shadcn/ui from existing apps.
- TreeView vs NodeSphere structural decisions.
- Any change visible to end users.
- `usdc-v2-frontend/` — slated for deprecation, leave alone.

## Decisions Made

- Package name: `@armada/ui`
- Location: `packages/ui/` (repo root)
- Naming convention: follow mockup (`--primitives-*` / `--semantic-*` layers)
- Font hosting: Google Fonts CDN (for now)
- Showcase will be built (step 5)
- ABOUTME comment convention applies to all source files (CLAUDE.md)
- Internal imports relative (no `@` path alias) — mirrors crowdfund-shared's convention

## Open Questions for the Designer (when reachable)

1. Do you have `scripts/build-tokens.ts`? Can you share it?
2. Are there design tokens defined in Figma? What naming structure?
3. Is the mockup code current with your latest Figma?
4. Are there primitives designed but not yet implemented (Dialog, Select, etc.)?
5. Hardcoded layout dimensions in the mockup (582px card width, 14px font gaps) — deliberate final values or interim?
