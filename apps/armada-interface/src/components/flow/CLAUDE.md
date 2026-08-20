# components/flow/

`FlowShell` + its supporting primitives — the shared chrome that wraps every modal flow (Shield / Send / Withdraw / Earn / Request / the activity receipt) in the app.

## Current contents

| Primitive | Purpose |
|---|---|
| `FlowShell` | **The live modal chrome.** Wraps the vendored `FlowModalOverlay + ModalShell + ModalStepSwitch` from `@/design` — logo + Steps progress + close + backdrop/focus-trap. Every feature modal renders this. Props: `open`, `onClose`, `flowLabel`, `steps`, `currentStep`, `status`, `hideSteps`, `exiting`, `stepKey`. |
| `useFlowExit` | Close hook — plays `FlowShell`'s slide-down before running the real `onClose` (holds `exiting` for `MODAL_EXIT_TOTAL_MS`; closes synchronously under reduced motion). Each modal wires `const { exiting, requestClose: close } = useFlowExit(() => setOpenModal(null))` and passes `exiting` to `FlowShell`; the atom stays set until the animation ends so the step content stays frozen. |
| `ProgressStep` | In-flight progress UI for any TxKind — calls `buildProcessingView(record)` and renders `components/tx/processing/TxProcessingLayout` off the live record. |
| `ErrorStep` | Icon + headline + message + Try Again (disabled when `onRetry` omitted) + optional View Details. |
| `FlowAmountHero` | Big-numeral amount hero used inside step bodies. |
| `WalletConfirmList` | Per-step "confirm in your wallet" checklist (shield signing sub-state). |
| `overlayFlow.ts` | `overlayIndicatorStep` / `overlayIndicatorStatus` — map a step string → the ModalShell Steps indicator position + status (default/confirmed/error). Used by the feature modals. |

### Legacy (retained, no runtime consumers)

`ActionFlowShell`, `FlowHeader`, `FlowFooter`, `FlowStepIndicator` predate the redesign and are **no longer rendered by any app code** (only their own tests). They're kept for now rather than deleted; don't build new flows on them — use `FlowShell`.

## FlowShell motion

`FlowShell` threads two motion props: `exiting` (drives the overlay/shell slide-down — set via `useFlowExit`) and `stepKey` (when it changes, the vendored `ModalStepSwitch` plays a short content exit then remounts the next step so its enter animations replay). Pass the modal's `step` string as `stepKey`; omit it for static shells (e.g. the activity receipt). Step bodies apply `modalStepBodyEnter` (body slides in) + `modalActionRowEnter` (buttons bounce in, staggered) from `@/design` so each step transition animates.

## Conventions

- Same as `components/ui/CLAUDE.md`: folder per primitive, ABOUTME header, CSS Module referencing `var(--semantic-*)` tokens, no Tailwind typography, no `clsx`/`cva`.
- Footer composition: each feature step renders its **own** button row (plain `@/design` `Button`s in a `depositOverlayShellStyles.buttonRow`, tagged `modalActionRowEnter`) inside its body. `FlowShell` owns only chrome, not footer content.
- Step labels + active tick come from `FlowShell`'s `steps` + `currentStep` props (backed by `ModalShell`); the modal derives `currentStep` from its step string (often via `overlayFlow.ts`).

## Step indicator semantics

`FlowShell` takes `steps` (labels) + a 1-based `currentStep` and renders the `ModalShell` Steps bar. The error step is **not** part of the indicator — it's an overlay that appears in place of whichever step failed, with a Try Again CTA that returns the user to that step. Don't include `error` in the visible step count.

## Wallet-signing step (shield)

`shield` is the only kind that surfaces a wallet signature, and it now has a **dedicated `wallet` step** (the mockup's step 3) between `review` and `progress` — `components/shield/ShieldWalletStep`, rendering `WalletConfirmList` from `lib/tx/shieldWalletSteps` (live approve/sign statuses). `useShieldFlow` advances `wallet → progress` once `shieldWalletInteractionsComplete(record)`, so by the time `progress` shows, the wallet prompts are done (no duplicate "Confirm in your wallet" in the progress timeline). Other kinds (unshield/transfer/yield) have no wallet-sign step — they're relayer-submitted; their brief `executionState === 'waiting'` still shows in `ProgressStep`'s stage copy.
