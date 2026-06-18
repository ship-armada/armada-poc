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
| `Header` | ArmadaLogo, NavBar, Button, WalletPillMenu |
| `WalletPillMenu` | Button (CSS Module) + `@web3icons/react` + `@heroicons/react` |
| `BarTrackTicks` | — |
| `Progress` | BarTrackTicks, Tag |
| `WalletButton` | — |
| `Steps` | — |
| `Tooltip` | — |
| `WalletItem` | — |

## Approved deviations from byte-identical port

- **`ArmadaLogo`** — the SVG markup was defined as a local helper inside the mockup's `Header.tsx`. We hoisted it into its own primitive so consumer apps can build their own header chrome (e.g. crowdfund-shared's `AppHeader`) without duplicating the SVG. `Header.tsx` now imports `ArmadaLogo` from a sibling instead of declaring it inline. The SVG markup itself is byte-identical to the mockup.
- **`WalletButton`** — at the original pin (commit `07e69bd`), the mockup shipped `.walletBtn` / `.walletIcon` / `.walletText` as inline rules inside `Header.module.css`. We extracted them into a standalone `WalletButton` primitive so consuming apps could drop a styled wallet pill anywhere (header right slot, mobile sheet, future settings UI) without forking the gradient-border CSS. The designer has since dropped those inline rules — the current mockup's `Header` renders the wallet pill as `<Button variant="secondary" label={walletAddress} showIcon={false} />`. The re-ported `Header` follows the mockup's current shape (no `WalletButton` in `Header`); the primitive stays in the package because `crowdfund-committer/src/App.tsx` imports it directly for the connected-wallet pill. The button is **visual-only** — wallet provider logic (wagmi, RainbowKit, etc.) stays in the consuming app, which composes its own state machine and passes a `label` + `onClick` to `WalletButton`. This keeps `@armada/ui` free of wallet-stack dependencies. Adds a `disabled` prop + matching `:disabled` CSS (opacity 0.5, `cursor: not-allowed`) — not in the mockup, but needed for transient states like wagmi hydration where the button should be non-interactive.
- **`Header.tsx` value/type import split** — the mockup uses `import { NavBar, NavBarItem } from '../NavBar'`. Our consumers (`committer`, `observer`, `admin`) compile with `verbatimModuleSyntax: true`, which requires type-only imports to use `import type`. Header.tsx splits the import (`import { NavBar }` plus `import type { NavBarItem }`). Same runtime behaviour; satisfies stricter consumer tsconfigs that transitively type-check this source.
- **Promoted prop interfaces** — `Steps`, `Tooltip`, and `WalletItem` declare their prop interfaces as `interface XProps {…}` (un-exported) in the mockup. We add the `export` keyword to those declarations so the per-component `index.ts` can re-export the type and downstream consumers can write `import { Steps, type StepsProps } from '@armada/ui'`, matching the surface of every other primitive in this package. No runtime change; one keyword added per interface.
- **Default export preserved with named re-export at the barrel** — `Steps`, `Tooltip`, and `WalletItem` are `export default` in the mockup. We keep that in the component file (verbatim body) and re-export as a named symbol in the per-component `index.ts` (`export { default as Steps } from './Steps'`), so consumers always import via the package's named surface.
- **`WalletPillMenu` co-located inside `Header/`** — the designer ships this as a sibling file in `Header/` (`Header/WalletPillMenu.tsx`) since it's only consumed by `Header`. We mirror that structure rather than hoisting to a top-level `WalletPillMenu/` folder. It is still re-exported from the package barrel (`@armada/ui`) so any future consumer can pull it independently. The committer's connected-wallet pill now renders `WalletPillMenu` directly (inside its own RainbowKit `ConnectButton.Custom`), so the primitive is exercised in production, not only by the showcase.

### Light-mode support (dark-preserving)

A product decision keeps **dark mode byte-identical** while light mode is opt-in and still being validated. The mockup (`armada-crowdfund` commits `c9f5807` + `d2ec1d5`) applied several light-mode colour changes to *base* rules; we **re-scope those to `[data-theme='light']`** so dark stays exactly as ported. These are deliberate deviations, not drift:

- **`tokens.css` `[data-theme="light"]` block** — populated with the mockup's real light values (faithful). The `armada-tokens.json` reference is single-theme (the dark base) and stays byte-identical to the designer's own token source, which likewise carries no light block — so the light values live only in `tokens.css` and there is no JSON to mirror. The "keep `armada-tokens.json` in sync" rule applies to the dark block, which is untouched.
- **`NavItem`, `Header` (`.myPositionActive`), `WalletPillMenu` (trigger bg)** — base rules kept byte-identical; the mockup's light treatment (muted/lavender text, `#291433` on brand surfaces) is added as `:global([data-theme='light'])` overrides instead of editing the base. The `WalletPillMenu` light/dark toggle button + the `utils/theme.ts` helper (barrel-exported) are faithful ports of `d2ec1d5`.
- **`ArmadaLogo` theme-aware wordmark fill** — instead of the mockup's light-PNG swap (`armada-logo-light.png` + `.fullLight`/`.fullDark` toggle), the wordmark path's `fill` is driven from a new `ArmadaLogo.module.css` (`fill: var(--semantic-color-text-primary)`): white in dark (byte-identical render), dark ink in light. Avoids shipping a per-app raster asset and keeps the whole logo SVG.

### `WalletPillMenu` dropdown fixes (both themes)

- **`align` prop** — additive optional prop (`'center' | 'right'`, default `'center'` = mockup behaviour). `'right'` anchors the menu's right edge to the trigger and opens leftward so it can't overflow the viewport when the pill sits at a screen-edge slot (the committer header's right slot once the Participate CTA is gone). Default-preserving; the showcase is unchanged.
- **`.menu` single-card treatment** — the mockup's `.menu` used `spacing-2` transparent padding + `item` radius + a `surface-bg`-tied box-shadow. On a light page that shadow inverts to a pale halo and the padding/radius read as a second card framing the menu (and the gap is loose even on dark). Changed the base to `padding: 0` + the card's `modal` radius + a real drop shadow (`rgba(0,0,0,0.5)` dark, `rgba(46,35,35,0.16)` light) so it reads as one clean floating card in both themes. This is the one intentional dark-mode visual change.

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
