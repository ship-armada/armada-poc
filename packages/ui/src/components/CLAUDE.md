# @armada/ui — Components

Primitives ported (byte-identical) from `/Volumes/T7/armada-crowdfund/src/components/`. The mockup is the visual source of truth; this directory is its tracked image inside the monorepo.

## Currently ported

| Component | Depends on |
|-----------|-----------|
| `ArmadaLogo` | — |
| `Button` | — |
| `Tag` | — |
| `NavItem` | — |
| `NavBar` | NavItem |
| `Header` | ArmadaLogo, NavBar, Button |
| `BarTrackTicks` | — |
| `Progress` | BarTrackTicks, Tag |
| `WalletButton` | — |

## Approved deviations from byte-identical port

- **`ArmadaLogo`** — the SVG markup was defined as a local helper inside the mockup's `Header.tsx`. We hoisted it into its own primitive so consumer apps can build their own header chrome (e.g. crowdfund-shared's `AppHeader`) without duplicating the SVG. `Header.tsx` now imports `ArmadaLogo` from a sibling instead of declaring it inline. The SVG markup itself is byte-identical to the mockup.
- **`WalletButton`** — the mockup ships `.walletBtn` / `.walletIcon` / `.walletText` as inline rules inside `Header.module.css`, not as a standalone component. We extracted them into a `WalletButton` primitive so consuming apps can drop a styled wallet pill anywhere (header right slot, mobile sheet, future settings UI) without forking the gradient-border CSS. The button is **visual-only** — wallet provider logic (wagmi, RainbowKit, etc.) stays in the consuming app, which composes its own state machine and passes a `label` + `onClick` to `WalletButton`. This keeps `@armada/ui` free of wallet-stack dependencies. Adds a `disabled` prop + matching `:disabled` CSS (opacity 0.5, `cursor: not-allowed`) — not in the mockup, but needed for transient states like wagmi hydration where the button should be non-interactive.
- **`Header.tsx` value/type import split** — the mockup uses `import { NavBar, NavBarItem } from '../NavBar'`. Our consumers (`committer`, `observer`, `admin`) compile with `verbatimModuleSyntax: true`, which requires type-only imports to use `import type`. Header.tsx splits the import (`import { NavBar }` plus `import type { NavBarItem }`). Same runtime behaviour; satisfies stricter consumer tsconfigs that transitively type-check this source.
- **`WalletPillMenu` `extraSection?: ReactNode` slot** — same precedent as `WalletButton.disabled`. The mockup ships `WalletPillMenu` with a fixed dropdown card (identity + copy + disconnect). `armada-interface` needs to surface a second identity inside the same pill (the shielded `0zk…` address, post V2 redesign — the EVM and shielded addresses are 1:1 representations of one user-facing identity, so two separate pills would mislead). The slot lets the consuming app inject a `<ShieldedIdentitySection />` (lives in `apps/armada-interface/src/components/`) below the disconnect button, without forking the component or touching its visual rules. Crowdfund consumers (observer/committer/admin) omit the prop and render no extra section — back-compat is `undefined`-by-default.

## Layout convention

```
ComponentName/
  ComponentName.tsx          implementation
  ComponentName.module.css   co-located CSS Module
  index.ts                   barrel: re-export component + types
```

Folder, component, file, and barrel-export names match. No alternate casings, no `Foo/Foo.component.tsx`.

## Porting recipe (verbatim — follow exactly)

When the designer ships a new primitive in the mockup and we port it:

1. **Copy three files unchanged.** From `/Volumes/T7/armada-crowdfund/src/components/<Name>/` copy `<Name>.tsx`, `<Name>.module.css`, and `index.ts` into `packages/ui/src/components/<Name>/`. Use `cp` — no edits to body content.

2. **Verify byte-equality** of the bodies before adding headers:
   ```bash
   diff /Volumes/T7/armada-crowdfund/src/components/<Name>/<Name>.tsx \
        packages/ui/src/components/<Name>/<Name>.tsx
   ```
   Should report no differences.

3. **Prepend a two-line `ABOUTME:` header** to every file (`.tsx`, `.module.css`, `index.ts`). Use `// ABOUTME: ` for TS/TSX and `/* ABOUTME: ... */` for CSS. First line describes what the component is; second line states "Ported byte-identical from the armada-crowdfund mockup" (or analogous for sub-components / CSS files).

4. **Add a per-component barrel** to `src/components/index.ts` (if it exists; otherwise add to `src/index.ts` directly).

5. **Update the package-level `src/index.ts`** to re-export the new primitive.

6. **Run typecheck** from the repo root: `npm run typecheck --workspace=@armada/ui`. Expect zero output (success).

7. **Re-verify body byte-equality** (with header offset) after edits land — see the verification snippet in this directory's history.

## What you must NOT do during a port

- **No restyling.** If a token value needs to change, edit `../styles/tokens.css` (and mirror in `../tokens/armada-tokens.json`). Never hand-edit a component's CSS to change appearance.
- **No prop-shape changes.** If the mockup component takes `label: string`, the port takes `label: string`. Add or rename props only when the designer ships an updated version.
- **No introduced dependencies.** The current set is React-only. If the mockup adds a dep (e.g. `@heroicons/react`), add it as a peer dependency in `../package.json` at port time — but only if the mockup genuinely uses it. Don't pre-emptively add icon libraries.
- **No class-composition utilities.** Keep the manual `.filter(Boolean).join(' ')` pattern. Importing `clsx` or `cva` is forbidden in this package.
- **No `"use client"` directives.** Not applicable; this is not an RSC project.

## Re-syncing a previously ported component

If the designer updates a primitive in the mockup, treat it as a re-port:
1. Diff the mockup against the local copy: `diff -r /Volumes/T7/armada-crowdfund/src/components/<Name> packages/ui/src/components/<Name>` (you'll see the ABOUTME headers as expected diffs).
2. Re-copy the changed file(s), preserving the ABOUTME header in the local version (Edit just the post-header body).
3. Re-run typecheck and the showcase pixel-compare.

## Primitives we deliberately did NOT port

These exist in the mockup but are not part of the foundation:

| Mockup component | Why excluded |
|------------------|--------------|
| `Participate` | App-level CTA card; designer may still be iterating. |
| `ParticipantsTable` | Crowdfund-specific data table — belongs in `crowdfund-shared`, not the design system. |
| `HeroParticipantsPanel` | Same — crowdfund-specific. |
| `HopStatCard` | Crowdfund-specific. Uses `BarTrackTicks` (which we did port). |

If a future app needs `BarTrackTicks` alone (without `Progress`), it can be imported on its own — it's already a peer primitive in this folder.

## When to add a CLAUDE.md to an individual component folder

Almost never. Per-component conventions are inherited from this file. Only add a `<Name>/CLAUDE.md` if the component carries genuinely non-obvious behavior that would surprise a future maintainer (e.g. a custom hook with subtle invariants, a non-standard interaction model). The Header's `autoHideOnScroll` is the kind of thing that *might* warrant one if it grows; right now the inline JSDoc on the prop is enough.
