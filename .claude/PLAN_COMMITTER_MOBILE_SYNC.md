# Plan — Port designer's mobile-friendly rework into the crowdfund committer

Source: designer reference repo `/Volumes/T7/diegoprudencios/armada-crowdfund`, commits
`27bf99d`→`f4ec589` (the "mobile" work — 5 commits, ~1,800 lines, 45 files).
Spike branch: `spike/committer-mobile-design-sync` (off `iskay/crowdfund-committer-ui-redesign`).

## Designer's mobile architecture (mirror, don't reinvent)
- **No `useIsMobile` hook, no portal.** JS branches call `window.matchMedia(\`(max-width:${MOBILE_LAYOUT_MAX_WIDTH_PX}px)\`)` inline against a shared constant.
- **Breakpoints** (`viewportBreakpoints.ts`): `767` (mobile stack + burger), `1440` (laptop), `799h` (short viewport).
- **Mobile vertical stack via CSS `order`** in CrowdfundExperience: Progress → Participate → Graph → Participants.
- **Global stylesheet** (`mobile-layout.css`, imported once) reflows all modal screens via a `[data-flow-shell]` attribute on each step wrapper.
- **Touch affordances** via `(hover:none),(pointer:coarse)` queries.
- **Deferred graph mount on mobile** — NodeSphere mounts via `requestIdleCallback` so WebGL doesn't block first paint.

## Mapping (designer → our packages)
| Designer file(s) | Our location | Type | Risk |
|---|---|---|---|
| `viewportBreakpoints.ts`, `mobile-layout.css`, `global.css` | new in `crowdfund-shared` (+ committer import) | new / 1 import | low |
| `Progress`, `JoinButton`, `InviteLanding`, `MyPositionHero/Split`, Step3/4/5 `.module.css` | `@armada/ui` + `crowdfund-shared` + committer | CSS-only `@media` | low |
| `ArmadaLogo.tsx` (+ `armada-symbol-color.png`) | `@armada/ui` | TSX rewrite, backward-compat | re-port discipline |
| `Header.tsx` + new `HeaderMobileMenu.*` | `@armada/ui` (fidelity); committer renders `AppHeader` | TSX-structural + new | **highest** |
| `CrowdfundExperience.tsx` (+343) | `crowdfund-shared` — diverged (`onDetails`) | TSX-structural | 3-way merge |
| `HeroParticipantsPanel` (+ new `HeroParticipantsMobileStack`) | `crowdfund-shared` — diverged (`onDetails`) | TSX-structural | merge |
| `SlotCard`, `Step0Invite`, `Participate`, `Step2Commit`, `ParticipateFlowModal` | `crowdfund-shared` — some diverged | TSX + CSS | merge |
| `DepositFlow.module.css` | — | — | N/A (no DepositFlow in committer) |

## Phases (each testable at a mobile viewport)
- **Phase 0 — Foundations + CSS-only appends (low risk).** `viewportBreakpoints` constant; `mobile-layout.css` + import; additive `@media (max-width:767px)` blocks for Progress, JoinButton, InviteLanding, MyPosition Hero/Split, Step3/4/5. Isolated, safe even on diverged files.
- **Phase 1 — `@armada/ui` re-sync.** `ArmadaLogo` variant refactor (backward-compat), `Header.module.css`, `Progress.module.css`, `armada-symbol-color.png`, per the package's byte-identical port recipe.
- **Phase 2 — Shared domain components.** Re-apply mobile changes onto our (diverged) copies: `HeroParticipantsPanel` + new `HeroParticipantsMobileStack`, `SlotCard`, `MyPosition/InvitesCard`, `Step0Invite` hover-gate, `Participate.tsx` poster fix, `Step2Commit` `allocationSection`; add `data-flow-shell` to step wrappers. Merge, don't copy.
- **Phase 3 — CrowdfundExperience.** 3-way merge: `.graphHost` relocation, deferred `mountGraph`, mobile participants stack, zeroed transitions, CSS `order`. Hardest merge (we added `onDetails`).
- **Phase 4 — Committer header + wiring.** Port the burger-menu experience into `AppHeader` (replacing the shadcn `Sheet`), wired to **RainbowKit** (not `@web3icons`); `layout="hero"`; modal corner-logo; `mobile-layout.css` import.

## Risks / decisions
1. **Header is the real work** — committer `AppHeader` ≠ `@armada/ui Header`, wallet is RainbowKit not `@web3icons`. Decision: port `HeaderMobileMenu` look into `AppHeader` + RainbowKit (recommended) vs restyle the `Sheet`. Lock before Phase 4.
2. **Diverged-file merges** — CrowdfundExperience, HeroParticipantsPanel, SlotCard, Step0Invite: re-apply on top of our changes (onDetails / ENS / zero-addr / secondsLeft).
3. **Hidden desktop-affecting changes** inside "mobile" commits — `Participate.tsx` poster/preload, modal close-button, `Step2Commit` regroup are not media-gated; confirm wanted on desktop.
4. **`@armada/ui` byte-identical discipline** for ArmadaLogo/Header/Progress re-ports.
5. **Deps:** `@heroicons` ✓; `@web3icons` only if porting the wallet block verbatim — avoid via RainbowKit.
6. `749878e`/`6fbc168` revert pair nets to zero; surviving poster fix is `154b402`.

## Phase 0 checklist — DONE
- [x] `MOBILE_LAYOUT_MAX_WIDTH_PX = 767` added to existing `viewportBreakpoints.ts` + barrel export (our copy was pre-mobile, missing it)
- [x] `mobile-layout.css` (global) in `crowdfund-shared/styles` + `./styles/mobile-layout.css` package export + import in committer `index.css`
- [x] CSS `@media` appends: Progress (`@armada/ui`), JoinButton, InviteLanding (committer), MyPositionHero, MyPositionSplit, Step3Review, Step4Approve, Step5Confirmation

Notes: our copies of some `.module.css` had minor structural divergence (Step4Approve, MyPosition Hero/Split use 900/1100px blocks) — placed each append/insert by matched anchor, not blind line numbers. The `mobile-layout.css` rule is inert until Phase 2 adds `[data-flow-shell]` to the step wrappers. Verify the CSS `@import` resolves in the committer dev server (export map added; mirrors the working `theme.css` export).
