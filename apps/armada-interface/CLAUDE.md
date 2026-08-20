# @armada/interface

USDC user app on the Armada protocol — shield, unshield, yield, payments, cross-chain. Replaces the legacy `usdc-v2-frontend` app.

**Status:** V2 shielded-wallet redesign landed (Path C). A single state-agnostic **`SignInFlow`** is the account entry for first visit AND returning users — `signIn()` first-derives or re-derives the same identity, so there is no create/unlock split. Backup-file + paste-secret recovery (for smart-account wallets / cross-device) sit behind a "Restore wallet from backup" link; a non-deterministic signer routes to the full-page compatibility screen. Per-(EVM address, account) walletId map in localStorage drives account-switch detection + auto-lock. Tx history is scoped to the active walletId and AES-256-GCM-encrypted at rest under a per-wallet key. See `specs/TX_SIGNING.md` + `specs/TX_SIGNING_V2_AMENDMENT.md`. Tx flows (shield/unshield/payments/yield) are wired end-to-end.

**V1 Phase 9 — chain history recovery (landed):** on unlock, `useHistoryRecovery` reconstructs history from the `@armada/sdk` wallet scan (`runHistoryScan` → `historyEntryToTxRecord`) and synthesizes terminal `TxRecord`s for shields / transacts / unshields / yield ops not already in local IDB. `useIncomingTransferDetector` re-fires the scan on every SDK balance event so received transfers (which the user didn't author) surface live. A per-wallet localStorage checkpoint makes subsequent scans incremental. Settings → "Re-scan history" / "Clear local history" let the user force a refresh or wipe locally. See `lib/shielded/history.ts`, `hooks/useHistoryRecovery.ts`, and `test/integration/history-recovery.test.tsx`.

## Plan

Architectural decisions and rationale: `../../.claude/PLAN_ARMADA_INTERFACE.md`. **Read first.** It defines the tx lifecycle model, polling matrix, security boundary, and 19 locked decisions.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Build | Vite 7 | `vite.config.ts` includes the `serveDeployments()` plugin for hub + client manifests |
| Framework | React 19 + TypeScript strict + `noUncheckedIndexedAccess` | Stricter than committer |
| Wallet | wagmi + RainbowKit + viem + ethers v6 | Same as crowdfund-committer; `walletClientToSigner` bridges to ethers |
| State | Jotai | Atoms in `src/state/`, derived inline in hooks |
| Server state | `@tanstack/react-query` | All HTTP, all RPC reads, all polling that fits the request/response shape |
| Styling | Vendored design system in `src/design` (CSS Modules + tokens, imported as `@/design`) + Tailwind v4 (layout glue) | Severed from the shared `@armada/ui` so the app is self-contained. No typography Tailwind classes in app code — body baseline (15px Geist 1.5) drives everything |
| Persistence | IndexedDB (`lib/cache.ts`) | Stores tx history, fee quotes, ENS, shielded balance snapshots |
| Routing | `react-router-dom` 7 | Routed pages: Dashboard (`/`), Debug (`/debug`), parked AddressBook, and the standalone `PayViaLinkLanding` (`/pay-via-link`, outside the App shell). Settings is a modal, not a page; `/history` was retired |
| QR | `qrcode.react` | Renders the pay-via-link QR (`components/payViaLink/PaymentLinkQrCode`) |

## Folder map

```
src/
├── main.tsx                 provider tree (StrictMode → Wagmi → Query → RainbowKit → Jotai → Router)
├── App.tsx                  installs visibility listener + hydrates tx history; renders <AppLayout>
├── index.css                @import tailwindcss + ./design/styles tokens.css + global.css
├── design/                  vendored design system (@/design) — primitives + tokens/typography CSS; severed from @armada/ui
├── config/                  env-driven config — network, wagmi, deployments, relayer
├── lib/                     pure logic, no React (rpc, cache, format, revert, wagmi-adapter, telemetry, relayer, cctp)
│   ├── shielded/            @armada/sdk wrappers (wallet, keyManager, sdk-read, sdk-prover, sync, balance-bus, network, artifacts) — stock engine fully removed
│   └── tx/                  lifecycle model — types, lifecycles, reducer, storage, poller
├── state/                   Jotai atoms (tx, wallet, fees, visibility, ui)
├── hooks/                   per-concern hooks (useWallet, useShieldedWallet, useBalances, useYieldRate, useFees, useTx, useTxHistory, useTabVisible)
├── components/              AppLayout, WalletConnector, plus subfolders for each feature (dashboard/, shield/, yield/, payments/, tx/, settings/) — payments/ is the shared Send/Withdraw flow
└── pages/                   Dashboard, Debug, AddressBook, PayViaLinkLanding (Settings is a modal)
```

## Conventions (enforced)

- **All source files start with two-line `// ABOUTME:` comments.** Project-wide rule from the root CLAUDE.md.
- **No `ethers` or `@railgun-community/*` imports in `components/**`.** Business logic lives in `hooks/` and `lib/`. Components are dumb.
- **No `console.log`/`console.debug` in `lib/shielded/`.** Secret-leak prevention. Use `lib/telemetry.ts` instead. Telemetry is **typed** via an event registry (`lib/telemetry.ts::EventRegistry`); arbitrary props are not allowed.
- **No typography Tailwind classes app-wide.** `text-xs`/`font-*`/`tracking-*`/`leading-*`/`uppercase` etc. are forbidden — typography flows from the body baseline + `@/design` CSS Modules. Layout utilities (`flex`, `grid`, `mx-auto`, `pt-20`, color tokens) are fine.
- **TS strict + `noUncheckedIndexedAccess`.** No `any`, no `as any`. If a type is opaque (e.g. wagmi internals), narrow at the boundary.
- **Tx executor lives at module scope, not React scope.** `lib/tx/executor.ts` initialises via `startEngine()` (called once from `App.tsx`). Hooks dispatch `executeTx(id)` / `cancelTx(id)`; they don't orchestrate.
- **Single-leader execution.** Only the tab holding the `armada-tx-executor` `navigator.locks` lock runs handlers. Other tabs are passive observers. v1 has no follower-side live sync — opening multiple tabs means only the first is active.
- **Polling goes through React Query.** All HTTP and RPC reads that fit a request/response shape use `useQuery` / `useQueries`, configured with `refetchIntervalInBackground: false` so hidden tabs don't burn quota. Don't write bespoke `setInterval` pollers.
- **`eth_getLogs` is always bounded.** Never query from genesis or with an unbounded `toBlock` on a public RPC. Either chunk via `lib/events/getLogsChunked` or scan one bounded window per poll tick (see `features/unshield-xchain/scan.ts`). The per-network cap lives in `NetworkConfig.maxLogRange` (5_000 on sepolia, 100_000 on local).
- Per-folder CLAUDE.md captures folder-specific conventions.

## Dev commands

```bash
# From repo root
npm install --legacy-peer-deps        # if dependencies changed
npm run armada:interface              # → http://localhost:5176

# Or equivalently:
npm run dev --workspace=@armada/interface

# Typecheck only
npm run typecheck --workspace=@armada/interface
```

For local mode (`VITE_NETWORK=local` — default), three Anvil chains must be running on `:8545` / `:8546` / `:8547`. Use the existing `npm run chains` + `npm run setup` from the repo root.

For Sepolia, set `VITE_NETWORK=sepolia` and ensure manifest files exist in `deployments/` (`privacy-pool-hub-sepolia.json`, `privacy-pool-client-sepolia.json`, `privacy-pool-clientB-sepolia.json`).

## Duplicated utilities

`src/lib/rpc.ts`, `format.ts`, `wagmi-adapter.ts`, `revert.ts` are duplicates of files in `@armada/crowdfund-shared`. They live here so this app doesn't depend on a crowdfund-named package. When both apps need to evolve these, extract them to a new `@armada/eth-utils` package (Plan §19). Don't pre-extract.

## Tx lifecycle model — required reading

The central design is in `src/lib/tx/types.ts`, `src/lib/tx/lifecycles.ts`, and `src/lib/tx/executor.ts`. Every transaction kind (`shield`, `unshield-local`, `unshield-xchain`, `transfer-shielded`, `yield-deposit`, `yield-withdraw`, `payment-xchain`) declares its own stage sequence with a per-kind `maxDurationMs` + `retry` policy. Records carry an `executionState` (lifecycle position: `pending | active | waiting | retrying | completed | failed | expired | cancelled`) separate from the protocol `stage`. The same `useTx()` hook handles all kinds; the same future `<TxLifecycleStepper>` component renders any record. Adding a new kind is a 3-file change:

1. Extend the `TxKind` union and add a stage union in `lib/tx/types.ts`.
2. Add a lifecycle entry in `lib/tx/lifecycles.ts`.
3. (Optional) Add custom rendering in `components/tx/`.

This model fixes the crowdfund-committer's `useTransactionFlow` single-tx limitation — multi-instance, persistent, cross-chain-aware.

## What's intentionally NOT in the scaffold

- Tx flows (shield/shield-xchain/unshield-local/unshield-xchain/transfer/yield) are wired end-to-end against real contracts + CCTP and run real ZK proofs; what's NOT done: the relayer-*mediated* submit path (`lib/relayer.ts::submitRelay` — today every handler submits from the user's own wallet via wagmi) and finer-grained real-CCTP-mode Iris polling (the xchain handler collapses the last delivery stages on a single destination-balance detection).
- e2e tests.
- A remote telemetry sink beyond Sentry. Sentry error capture IS wired (`lib/sentry.ts`, DSN-gated via `VITE_SENTRY_DSN` — see DEPLOYMENT.md), but the structured `track()` info events remain console-only.
- Service worker / offline support.
- i18n.
- Mnemonic import flow (only generate-on-first-run, per Plan §15.7).
