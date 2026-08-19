# components/flow/

ActionFlowShell + its supporting primitives. This is the shared chrome that wraps every modal flow (Shield / Unshield / Send / Earn) in the app.

## Current contents

| Primitive | Purpose |
|---|---|
| `FlowStepIndicator` | Segmented "STEP N of M" bar with filled ticks up to the active step. ARIA progressbar. |
| `FlowHeader` | Title + optional close button + FlowStepIndicator. Bordered bottom. `showIndicator={false}` for the error step. |
| `FlowFooter` | Primary CTA (right) + optional secondary CTA (left). Mobile: collapses to vertical stack. |
| `ActionFlowShell` | Combines Modal + FlowHeader + body. Controlled by parent (`step` prop). Auto-locks dismissal during `progress`. |
| `ProgressStep` | Shared progress UI for any TxKind. **Stub** until `<TxLifecycleStepper>` lands in `components/tx/`. |
| `ErrorStep` | Icon + headline + message + Try Again (disabled when `onRetry` omitted) + optional View Details. |
| `useFlowExit` | Close hook — plays `FlowShell`'s slide-down before running the real `onClose` (holds `exiting` for `MODAL_EXIT_TOTAL_MS`; closes synchronously under reduced motion). Each modal wires `const { exiting, requestClose: close } = useFlowExit(() => setOpenModal(null))` and passes `exiting` to `FlowShell`; the atom stays set until the animation ends so the step content stays frozen. |

## FlowShell motion

`FlowShell` threads two motion props: `exiting` (drives the overlay/shell slide-down — set via `useFlowExit`) and `stepKey` (when it changes, the vendored `ModalStepSwitch` plays a short content exit then remounts the next step so its enter animations replay). Pass the modal's `step` string as `stepKey`; omit it for static shells (e.g. the activity receipt).

## Conventions

- Same as `components/ui/CLAUDE.md`: folder per primitive, ABOUTME header, CSS Module referencing `var(--semantic-*)` tokens, no Tailwind typography, no `clsx`/`cva`.
- Footer composition: each feature step renders its own `<FlowFooter primary={...} secondary={...}/>` inside its body. The shell does not own footer content — only chrome.
- Title accessibility: when `ActionFlowShell` wraps the Modal it should pass a generated `titleId` to `FlowHeader` and to the Modal's `aria-labelledby` so screen readers announce the flow title.

## Step indicator semantics

`FlowStepIndicator` accepts a 1-based `currentStep` and a `totalSteps`. The error step is **not** part of the indicator — it's an overlay that appears in place of whichever step failed, with a Try Again CTA that returns the user to that step. Don't include `error` in the visible step count.

## Wallet-signing sub-state (shield only)

Per the UI plan: `shield` is the only kind that surfaces a wallet signature. We do **not** model that as a separate flow step. Instead the executor's `executionState === 'waiting'` drives the active stage's copy inside `ProgressStep` (e.g. "Confirm in your wallet"). The shell stays at `step === 'progress'` throughout.
