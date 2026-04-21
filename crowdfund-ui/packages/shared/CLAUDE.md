# @armada/crowdfund-shared

Shared library for the crowdfund UI apps. Contains the data layer, event types, graph logic, and reusable view components consumed by the observer, committer, and admin packages.

**This is a library, not an app.** No Vite, no dev server, no index.html. It exports TypeScript source directly (`"main": "src/index.ts"`) — the consuming app's Vite bundler compiles it.

## Spec Reference

The data model, event types, and view component interfaces are defined in the **Observer spec**:
- `../../../../.context/CROWDFUND_OBSERVER.md`

Read this spec before implementing or modifying anything in this package.

## Package Structure

```
src/
  components/    # Observer view components (StatsBar, TreeView, TableView, NodeDetail, SearchBar)
  hooks/         # React hooks for data fetching and derived state
  lib/           # Pure functions — no React dependency, independently testable
  index.ts       # Barrel export
```

### `lib/` — Pure Logic (No React)

| File | Purpose |
|------|---------|
| `constants.ts` | Contract constants (sale params, hop configs, event signatures, ABI fragments) |
| `events.ts` | Event type definitions and parsing (raw log → typed event) |
| `format.ts` | USDC/ARM formatting, address truncation, countdown strings |
| `graph.ts` | Graph construction from events (nodes, edges, address summaries) |
| `cache.ts` | IndexedDB read/write helpers for event and ENS caching |
| `rpc.ts` | Multi-provider with ordered fallback for RPC calls |

These modules must have **no React imports**. They should be testable with plain vitest unit tests.

### `hooks/` — React Data Layer

| Hook | Purpose |
|------|---------|
| `useContractEvents` | Event fetching + polling + IndexedDB cache |
| `useGraphState` | Derived graph state from events (nodes, edges, summaries) |
| `useENS` | ENS resolution with IndexedDB cache |
| `useSelection` | Shared selection state between tree and table views |

These hooks use Jotai atoms for shared state. They are consumed by the observer's view components and by the committer's action panel.

### `components/` — Observer View Components

Domain components that render the crowdfund visualization. These are NOT UI primitives (Button, Card, etc.) — each app provides its own via shadcn/ui.

| Component | Purpose |
|-----------|---------|
| `StatsBar` | Live stats banner (per-hop demand, sale size, countdown) |
| `TreeView` | DAG visualization (Armada ROOT → hop-0 → hop-1 → hop-2) |
| `TableView` | Sortable, searchable, filterable participant table |
| `NodeDetail` | Expanded node/row detail (per-hop breakdown) |
| `SearchBar` | Shared search input (filters both tree and table) |

These components accept data via props — they do NOT fetch data internally. The data layer (hooks) is separate so the observer and committer can wire them differently.

## Import Pattern

Consuming apps import via the npm workspace package name:
```ts
import { CROWDFUND_CONSTANTS } from '@armada/crowdfund-shared'
import { useGraphState } from '@armada/crowdfund-shared/hooks/useGraphState'
import { StatsBar } from '@armada/crowdfund-shared/components/StatsBar'
```

## Conventions

- **No `@` path alias.** Use relative imports within this package. shadcn's generator bakes `@/…` into generated files; post-process to relative before merging (see UI Primitives section below).
- ethers v6 for ABI encoding and event parsing.
- Jotai for shared state in hooks.
- React is a peer dependency — it is NOT bundled with this package.
- All files must start with two-line ABOUTME comments.

## UI Primitives (shadcn/ui)

All shadcn primitives live in this package under `src/components/ui/` and are consumed by every app via the `@armada/crowdfund-shared` barrel export. There is only one shadcn installation in the workspace; the apps do NOT have per-app `components.json` or `ui/` directories.

### Adding or regenerating a primitive

1. From this directory, run `npm_config_legacy_peer_deps=true npx shadcn@latest add <name> --yes --overwrite`. The `legacy-peer-deps` env var is required because the Railgun SDK peer deps in the repo root conflict with Radix's peer ranges; without it, shadcn's internal `npm install radix-ui` fails with ERESOLVE.
2. shadcn writes files into `./@/components/ui/` because the components.json aliases are `@/…` and shared has no `@` path mapping — **move the files into `src/components/ui/`** and delete the `@` directory.
3. Rewrite imports in the generated files:
   - `from "@/lib/utils"` → `from "../../lib/utils.js"`
   - `from "@/components/ui/<sibling>"` → `from "./<sibling>.js"`
   - Strip any leading `"use client"` directive (this is a non-RSC project).
4. Prepend the project's two-line `// ABOUTME:` header to each new file.
5. Add the named exports to `src/index.ts`.

### Edit in place

shadcn primitives are **owned code**, not vendored deps — edit the generated file directly. Never wrap a primitive just to change its defaults; edit its cva config, markup, or imports in place. This is the intended shadcn workflow.

### Variant colors

Primitives pull colors exclusively from the theme tokens in `src/styles/theme.css` (`bg-primary`, `bg-destructive`, `bg-card`, etc.). When re-theming, swap the token values in `theme.css`; do not hand-edit color classes in individual primitives.

## Commands

```bash
npm run typecheck    # TypeScript type checking (no emit)
npm run test         # Run unit tests
npm run test:watch   # Run tests in watch mode
```
