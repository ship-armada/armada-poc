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

- **No `@` path alias.** Use relative imports within this package.
- ethers v6 for ABI encoding and event parsing.
- Jotai for shared state in hooks.
- React is a peer dependency — it is NOT bundled with this package.
- All files must start with two-line ABOUTME comments.

## Commands

```bash
npm run typecheck    # TypeScript type checking (no emit)
npm run test         # Run unit tests
npm run test:watch   # Run tests in watch mode
```
