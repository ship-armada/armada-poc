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
  - **Narrowed:** the committer renders `AppHeader`, not `@armada/ui Header` — so the committer-relevant Phase 1 item is just `ArmadaLogo` (Phase 4's burger needs `variant="mark" markTone="white"`). `@armada/ui Header.tsx`/`Header.module.css` re-sync is deferred to Phase 4 (no committer benefit, and a showcase-only re-port risks byte-drift). `Progress.module.css` mobile block landed in Phase 0. `armada-symbol-color.png` is a committer modal asset → Phase 4.

## Phase 1 checklist — DONE
- [x] Re-ported designer's `ArmadaLogo` (`variant: 'full' | 'mark'`, `markTone: 'brand' | 'white'`, `ArmadaMark` subcomponent, namespaced `armada-lg*` gradient IDs) into `packages/ui/src/components/ArmadaLogo/ArmadaLogo.tsx`. Body byte-identical to designer (only deviations: ABOUTME header + our pre-existing `= {}` default param). All 7 call sites use the default `full` variant → backward-compatible. Typechecks clean (`@armada/ui`, committer).
- **Phase 2 — Shared domain components.** Re-apply mobile changes onto our (diverged) copies: `HeroParticipantsPanel` + new `HeroParticipantsMobileStack`, `SlotCard`, `MyPosition/InvitesCard`, `Step0Invite` hover-gate, `Participate.tsx` poster fix, `Step2Commit` `allocationSection`; add `data-flow-shell` to step wrappers. Merge, don't copy.

## Phase 2a checklist — DONE (self-contained items)
- [x] `data-flow-shell` attribute on step wrappers: Step1Wallet, Step1WalletNotWhitelisted, Step2Commit (both shells — main + our `fullyCommitted` early-return), Step3Review, Step4Approve, Step5Confirmation — activates the inert `mobile-layout.css` from Phase 0.
- [x] `Step0Invite` — hover-gate (`(hover:hover) and (pointer:fine)` via `matchMedia`, so touch devices don't expand the Join CTA on tap), `data-flow-shell`, fluid card (width 100%/max-width 480/box-sizing), meta+footer `min-width:0`, mobile `@media` (card auto-height).
- [x] `Step2Commit` — mobile `@media` `.buttonRow` stacking (column-reverse, full-width). **Deferred:** the `.allocationSection` regroup + `titleBlock` gap-bump are built around the designer's `ArmAllocationBlock` component; our copy uses an inline `.allocationBlock` + extra validation messages, so applying them = a JSX rewrite (not done unasked). Desktop cosmetics only.
- [x] `Participate.tsx` — our copy already converged on the designer's poster intent (always-rendered `imageSrc` base layer + `poster={imageSrc}`); kept our deliberate `preload="none"` lazy-load state machine (reverting to designer's `preload="metadata"` would regress it); added decorative `<img>` `aria-hidden` to match.
- [x] `SlotCard` — full invite link (removed `truncateLink`), mobile revoke-popover positioning (clamps within viewport, flips below anchor if no room above), removed dead pre-position logic, mobile `@media` (link-active grid reflow, popover slide-in keyframe).

## Phase 2b — DEFERRED into Phase 3 / focused follow-up
- [ ] `HeroParticipantsPanel`: extract `HopFilterBar` helper + add `HeroParticipantsMobileStack`. **Folded into Phase 3** — the mobile stack is dead code until `CrowdfundExperience` mounts it (matchMedia + CSS `order`), and our panel diverged to show **ENS** names where the designer's stack shows raw `p.address`; port it ENS-reconciled and wired together.
- [ ] MyPosition invites-on-mobile (designer's `InvitesCard` `hero` variant: always-expanded, non-collapsible, transparent chrome). Our tree has no `InvitesCard` — adapt onto `MyPositionHero`'s invite section (`.inviteCard`/`.inviteHeader`/chevron).
- **Phase 3 — CrowdfundExperience.** 3-way merge: `.graphHost` relocation, deferred `mountGraph`, mobile participants stack, zeroed transitions, CSS `order`. Hardest merge (we added `onDetails`).
  - **Architecture mismatch found:** designer's mobile rework assumes their `CrowdfundLeftColumn` + split `HeroParticipantControls`/`HeroParticipantList`; we use a unified `HeroParticipantsPanel` + `leftStack` and have **no `CrowdfundLeftColumn`**. Their mobile CSS targets `[class*='controlsSlot']`/`[class*='listRegion']`/`[class*='middle']` — selectors that don't exist in our DOM. So Phase 3 is an *adaptation*, split into 3a/3b/3c:
    - **3a — mobile behavior logic (DONE, desktop-inert).** `isMobileLayout()` helper; `mountGraph` deferred WebGL mount via `requestIdleCallback`/`setTimeout(32)` fallback; `motionReady` mobile-init + skip-RAF; zeroed panel transitions on mobile; `NodeSphere` gated by `mountGraph`. All gate on `isMobileLayout()` → desktop unchanged. shared 270 + committer 162 tests green.
    - **3b — structural reflow (IMPLEMENTED, PENDING VISUAL VERIFY).** Designer intention confirmed: stats/Progress card only on mobile, participants in the stack. Landed: `HopFilterBar` extraction + `HeroParticipantsMobileStack` (ENS-reconciled `displayName ?? address`, our `multi` filter model) + its mobile CSS in `HeroParticipantsPanel`; barrel + package re-exports. `CrowdfundExperience`: `.experienceLayout`/`.graphHost` wrapper relocating `NodeSphere` (gated `mountGraph && !(isMyPosition && isMobileLayout())`); mobile stack between graph and left corner; `mobileParticipantsRef` in the outside-click handler; `.hideOnMobileStack` on the desktop participants wrap; `.mobileParticipateCard` on Participate; mobile `@media` reflow **re-authored against our classes** (no `CrowdfundLeftColumn`). shared 270 + committer 162 tests + typechecks green. **Two CSS risks `tsc` can't catch — must eyeball:** (A) relocating `NodeSphere` into `.experienceLayout` changes its positioning context (desktop should be identical — wrapper fills the page); (B) heroStyles-vs-shellStyles cascade on the mobile corner `position:relative`/`order` overrides (shellStyles imports after heroStyles → wins; distinct hashed classes, no specificity clash).
    - **3c — Header `layout="hero"`** → folds into Phase 4 (our `@armada/ui` Header lacks the `layout` prop; that's the Phase-4 Header re-sync).
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
