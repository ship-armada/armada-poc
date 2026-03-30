# @armada/crowdfund-observer

Read-only, real-time visualization of the Armada crowdfund: invite graph, commitment data, and allocation status. No wallet connection, no write transactions.

## Spec

**Read this first:** `../../../../.context/CROWDFUND_OBSERVER.md`

The spec defines everything: data model, views (tree + table + stats banner), interaction patterns, state transitions, data fetching strategy, and technical architecture.

## Architecture

This app wires shared components and hooks from `@armada/crowdfund-shared` into a standalone layout. The shared package owns the data layer (event fetching, graph construction, caching) and the view components (StatsBar, TreeView, TableView). This app provides:

- `App.tsx` — layout: stats bar at top, tree + table split below
- Standalone data fetching initialization (RPC provider setup, polling start)
- Any observer-specific configuration (RPC URLs, contract addresses from deployment manifests)

## Development

```bash
# From project root
npm run crowdfund:observer    # Starts on port 5173

# Or from this directory
npm run dev
```

Requires deployed contracts. Run `npm run setup` from the project root first (starts Anvil chains + deploys contracts). The Vite dev server serves deployment manifests from `../../../../deployments/` via the `serveDeployments()` plugin.

## Dependencies

Current dependencies are the scaffold baseline. When implementing, add:
- `d3-hierarchy` + `d3-force` — layered DAG layout for the tree view
- `@tanstack/react-table` — sortable/filterable table
- `idb` — IndexedDB wrapper for event and ENS caching
- `wagmi` — ENS resolution hooks (read-only, no wallet connection needed)

## Key Patterns

- **ethers v6** for RPC interaction and event parsing (not viem)
- **Jotai** for shared state between tree and table views
- **Tailwind v4** with shadcn/ui (New York style) for UI primitives
- **`@` path alias** maps to `src/`
- All source files must start with two-line ABOUTME comments
- Style theme matches `../../crowdfund-frontend/` — dark mode, oklch colors, Inter font

## Shared Package Usage

```ts
import { CROWDFUND_CONSTANTS, formatUsdc } from '@armada/crowdfund-shared'
// Future: import { StatsBar } from '@armada/crowdfund-shared/components/StatsBar'
// Future: import { useGraphState } from '@armada/crowdfund-shared/hooks/useGraphState'
```

The shared package exports TypeScript source directly — Vite compiles it. Changes to shared are reflected immediately in the dev server.

## Deployment Manifests

Contract addresses and ABIs are loaded from deployment JSON files:
- Local: `crowdfund-hub.json` (created by `npm run setup`)
- Sepolia: `crowdfund-hub-sepolia.json`

Fetched via `fetch('/api/deployments/crowdfund-hub.json')` — the Vite plugin serves these from the project's `deployments/` directory.

Network mode is controlled by `VITE_NETWORK` env var (`local` default, `sepolia` for testnet).
