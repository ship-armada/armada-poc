# Plan — Port the designer's light mode into the committer (dark-mode-preserving)

Source: design reference `/Volumes/T7/diegoprudencios/armada-crowdfund`, commits
`c9f5807` (light token values + drift fix) and `d2ec1d5` (light-mode UI, theme
toggle, chrome fixes). Designer flagged it **unverified** ("Light mode not yet
verified visually"). Spike branch: `spike/committer-light-mode`.

## Governing principle
Keep **dark mode byte-identical**. Every change is one of:
- **light-scoped** — `[data-theme="light"]` block / `:global([data-theme='light'])` override (inert in dark);
- **dark no-op** — theme-aware token swap that resolves to the same value in dark (e.g. `white-full` → `text-primary`, which *is* white in dark);
- **Group C** — the only base change ported to both modes: `SlotCard` `min-width: 0` ×4 (a layout/overflow fix, not a theme change).

The designer applied **Group A** (`#291433` dark-text on bright brand surfaces) and
**Group B** (`HeroParticipantsPanel` filter bg) to the *base* rule. We **re-scope
them to `[data-theme="light"]`** so dark is unchanged. Default theme = dark; light
is opt-in.

### Change inventory (from the per-line audit)
- **Group A (re-scope to light):** A1 `tokens` `:root button-primary-text → #291433` · A2 `tokens` `:root button-gradient-text → #291433` · A3 `JoinButton color → #291433` · A4 `NavItem` default→`text-muted`, hover→transparent+`text-secondary`, active→lavender+`#291433` · A5 `Header.myPositionActive` → lavender+`#291433` (showcase-only — committer renders `AppHeader`).
- **Group B (re-scope to light):** B1 `HeroParticipantsPanel` filter bg `surface-raised 55/58%` → `neutral-50 72%`.
- **Group C (port to BOTH):** C1 `SlotCard` `min-width: 0` ×4.
- **Dark no-ops (port to base):** `Participate` + `Step0Invite` locked `text-primary:#fff` on brand-video surfaces; `ParticipateFlowModal` close `white-full` → `text-primary` (our mobile round-white close only — keep our desktop bordered pill).
- **Light-only (port as-is):** `ArmadaLogo` light/dark swap (+`armada-logo-light.png`); `WalletPillMenu` light trigger bg; `tokens` `[data-theme='light']` block (incl. inverted tag bg/label).

## Phases

### Phase 0 — Investigate (before code)
- What drives the committer's page bg + chrome colors: `@armada/ui --semantic-color-surface-bg` (flips for free with the light token block) vs the committer's shadcn `theme.css` (`--background`/`--foreground`, NOT designer-themed). Sizes Phase 5.
- `ArmadaLogo` light swap: designer ships a PNG + `.fullLight`/`.fullDark` toggle, but OUR `ArmadaLogo` is inline SVG — read the `.tsx` diff to decide integration.
- Confirm `--primitives-color-neutral-50` (B1's light value); confirm light token block completeness; re-confirm our diverged files (`HeroParticipantsPanel`, `ParticipateFlowModal`, `Step0Invite`, `Participate`) so we reconcile, not copy.

### Phase 1 — `@armada/ui` tokens (light block, dark-safe)
- Add the real `[data-theme="light"]` block to `tokens.css` + mirror in `armada-tokens.json`; apply drift fix (text-secondary 70%, add `white.70`) if present.
- A1/A2 fall out for free: light block already sets the `#291433` button text; **do NOT touch `:root`** (dark keeps `neutral-0`). Verify `:root` unchanged.

### Phase 2 — `@armada/ui` component light overrides (Group A + scoped)
Keep dark base; add `:global([data-theme='light'])` overrides:
- A4 `NavItem`, A3 `JoinButton`, A5 `Header.myPositionActive` (showcase, low-pri).
- `ArmadaLogo` light swap (scoped) + PNG asset; `WalletPillMenu` light trigger bg (already scoped — port as-is).

### Phase 3 — `crowdfund-shared` components (reconcile w/ mobile mods)
- B1 `HeroParticipantsPanel`: dark base kept; `[data-theme='light']` override for filter bg.
- Dark no-ops to base: `Participate` + `Step0Invite` locked-white vars; `ParticipateFlowModal` close `white-full`→`text-primary` (mobile round-white only).
- C1 `SlotCard` `min-width:0` ×4 → base (both modes).

### Phase 4 — Theme system + toggle (committer)
- Port `utils/theme.ts` → committer (get/set/toggle, localStorage persist, set `data-theme` on `<html>`); default dark.
- `index.html` bootstrap: set `data-theme` before first paint (no flash); default dark.
- Toggle in TWO places: `WalletPillMenu` dropdown (desktop pill) + `CommitterMobileMenu` (mobile).

### Phase 5 — Committer shadcn `theme.css` light palette (sized by Phase 0)
Derive `[data-theme='light']` values for shadcn tokens (`--background`/`--foreground`/`--card`/`--border`/`--muted`/…) so shadcn-driven chrome flips with the cards. Shrinks if Phase 0 shows chrome is mostly `@armada/ui`-sourced.

### Phase 6 — Verify
- Dark unchanged: only base edits are Group C + dark-no-ops; typecheck + tests + dark visual pass.
- Light works: toggle → sweep hero / participate modal / claim / `/invite` / header / mobile.

## Risks / unknowns
- **Phase 5** (shadcn light derivation — net-new, not in the designer's commit) and **`ArmadaLogo` SVG-vs-PNG** are the two real unknowns; Phase 0 resolves them.
- Reconcile (don't copy) on the files we modified for mobile.
