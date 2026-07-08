# @armada/ui

Shared visual design system. CSS Modules + design-token CSS variables. Consumed by the crowdfund apps (observer, committer, admin) and the future `armada-interface` app.

**This is a library, not an app.** No Vite, no dev server, no index.html. It exports TypeScript source directly (`"main": "src/index.ts"`) — the consuming app's bundler compiles it. No build step.

## Plan & decisions

The strategy, scope, deferred work, and open questions for the designer are captured in:
- `../../.claude/PLAN_ARMADA_UI_FOUNDATION.md` — **read this before making non-trivial changes.**

## What lives here

| Path | Purpose |
|------|---------|
| `src/styles/tokens.css` | Design tokens (CSS custom properties — `--primitives-*` and `--semantic-*`). Live source of truth for colors/spacing. |
| `src/styles/typography.css` | **Generated** typography composites (`--semantic-typography-*`, `.armada-text-*`). See `TYPOGRAPHY.md`. |
| `src/styles/global.css` | Reset and base body styles. Import once at the app entry point. |
| `src/components/Text`, `HeadingSm` | Typography primitives — use instead of per-screen title CSS. |

> **Consumers must import `tokens.css`** — every component CSS Module in this
> package references `--primitives-*` / `--semantic-*` variables defined
> there. Without the import, the components render unstyled (font, padding,
> bg, border-radius all undefined). Pattern:
>
> ```css
> /* app/src/index.css */
> @import "@armada/ui/styles/tokens.css";
> ```
>
> Apps that load tokens via JS instead can `import "@armada/ui/styles/tokens.css"`
> in their main entry — see `packages/ui/showcase/src/main.tsx`.
| `src/tokens/armada-tokens.json` | Reference copy of the upstream Style-Dictionary-formatted token source. Keep in sync when editing `tokens.css`. |
| `src/components/<Name>/<Name>.tsx` | Primitive component implementation. |
| `src/components/<Name>/<Name>.module.css` | Co-located CSS Module — scoped lexically, no global side effects. |
| `src/components/<Name>/index.ts` | Per-component barrel export. |
| `src/index.ts` | Package barrel — re-exports every primitive plus its types. |

## Strict conventions

**CSS Modules only.** No Tailwind, no shadcn, no styled-components, no CSS-in-JS. The whole point of the package is to escape inherited-class precedence surprises. If you find yourself wanting to add Tailwind here, push back.

**No utility libraries for class composition.** Use the manual filter+join pattern:
```ts
const cls = [styles.btn, styles[variant], cond && styles.x, className].filter(Boolean).join(' ')
```
Do not introduce `clsx`, `classnames`, `tailwind-merge`, or `cva`. They are the exact source of inheritance surprises we're avoiding.

**Tokens, not raw values.** Inside component CSS, reference `var(--semantic-*)` first, falling back to `var(--primitives-*)`. Never hardcode hex colors or px spacing in component CSS unless faithfully reproducing the mockup, in which case leave a comment naming the mockup file.

**Unitless tokens.** Some token values are intentionally unitless (e.g. `--primitives-fontSize-xs: 10`). Consuming CSS multiplies by `px` via `calc(var(--…) * 1px)`. Preserve this in ports.

**ABOUTME header on every source file.** Two lines, each starting with `// ABOUTME: ` or `/* ABOUTME: */` for CSS. CLAUDE.md project convention. JSON files are exempt (no comments allowed by the spec).

**Relative imports inside the package.** No `@/…` path alias. This mirrors `crowdfund-shared`'s convention.

**Verbatim ports from the mockup.** When porting a component from `/Volumes/T7/armada-crowdfund`, copy the `.tsx` and `.module.css` byte-identical (plus prepended ABOUTME headers). The mockup is the visual source of truth. Any deviation is a regression. See `src/components/CLAUDE.md` for the full porting recipe.

## Dependencies

- **React** as a peer dependency (`^19.0.0`). The mockup is built against 18.3.1 and our crowdfund apps against 19.1.1; we standardize on 19 for now. Widen the peer range if `armada-interface` ever needs 18.
- **No icon library yet.** The foundational primitives use inline SVG. When the designer ships a primitive that uses heroicons (the mockup's choice), add `@heroicons/react` as a peer dep at that point — not before.
- **No runtime utility deps.** Everything we need is in the React + CSS toolbox.

## Commands

```bash
npm run typecheck    # tsc --noEmit, run from this directory or via --workspace
```

There is no `build`, `test`, or `dev` script (yet — showcase app comes in step 5).

## Coexistence with the existing Tailwind/shadcn stack

The crowdfund apps still use Tailwind v4 + shadcn primitives via `crowdfund-ui/packages/shared/src/styles/theme.css` and `crowdfund-ui/packages/shared/src/components/ui/`. **That stack is untouched.** CSS Modules scoping means `@armada/ui` components and shadcn primitives cannot interfere even when rendered in the same DOM.

Screen-by-screen migration of crowdfund apps onto `@armada/ui` is **not** part of the foundation work — it waits until the designer has shipped more screens. See the plan note.

## What does NOT belong here

- Crowdfund-specific components (ParticipantsTable, HopStatCard, NodeSphere, etc.) → those live in `crowdfund-ui/packages/shared` or app-locally.
- Domain hooks, contract ABIs, state atoms → `crowdfund-shared`.
- Anything that imports from `crowdfund-shared` → would create a circular dependency. `@armada/ui` is downstream of nothing.

## Open questions for the designer

Listed in `../../.claude/PLAN_ARMADA_UI_FOUNDATION.md`. Top of the list is the missing `scripts/build-tokens.ts` that should regenerate `tokens.css` from `armada-tokens.json`.
