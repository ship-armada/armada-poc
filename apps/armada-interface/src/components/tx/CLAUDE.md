# components/tx/

Transaction-rendering primitives. Each one consumes a `TxRecord` and renders something appropriate — no fetching, no executor calls. Hooks own data; these own visuals.

## Contents

| Component | Purpose |
|---|---|
| `TxLifecycleStepper` | Vertical stepper for any `TxKind`. Reads `lifecycleFor(record.kind)` + record state. Status chip + per-stage rows + technical-details disclosure. |
| `TxRow` | Compact row — title + amount + status + relative time. Optional sub-line (stage copy) and progress strip for InProgressCard. V1 Phase 9 added the `transfer-shielded-received` kind: incoming privately-paid USDC rendered with the Inbox glyph + green inflow amount; synthesized from chain by useHistoryRecovery / useIncomingTransferDetector. |
| `TxStatusChip` | Maps `TxExecutionState` → `StatusChip` variant + label. Consolidates pre-terminal states (`pending`/`active`/`waiting`/`retrying`) under a single "Pending" badge. |
| `stageCopy.ts` | Pure helpers: `stageCopy(kind, stage, executionState?)`, `kindTitle(kind)`, `recordTitle(record)`. Single source of truth for tx microcopy. |

## Conventions

- **No data fetching inside components.** A row or stepper takes a record via props; the caller (page or feature component) reads `txListAtom` / `pendingTxsAtom` and forwards.
- **No business logic.** If you find yourself deriving lifecycle math (e.g. ETA-from-history) inside a render, push it into `lib/tx/` or a hook.
- **Copy lives in `stageCopy.ts`.** Adding a stage means editing that file's `COPY` map, not inlining copy in a component.
- **Explorer links via `getChainById(chainId).explorerUrl`.** Don't hardcode hostnames.
- **Don't expose raw stage strings in the primary UX.** They're allowed inside `TechnicalDetailsDisclosure` for debugging, never in the row title or stepper-row label.

## When `TxLifecycleStepper`'s assumptions break

The stepper trusts `record.stage` and `record.stagesCompleted` to be consistent with `lifecycleFor(record.kind).stages`. If they aren't, rows show "pending" by default (no row marked done/current). That's a bug in whichever code produced the record — fix it there, not here.

## Wallet-signing copy (shield only)

`shield`'s `submit-relayer` stage has two copy variants — `waiting` ("Confirm in your wallet") and `active` ("Submitting transaction"). The stepper picks based on the row's effective state (only the current row uses `executionState`; done/pending rows always use the default copy). Other kinds don't currently use the active/waiting variant pattern; add new entries to `COPY` if a kind grows the need.
