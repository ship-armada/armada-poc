# Crowdfund UI Workspace

Monorepo containing the Armada crowdfund frontend, split into four npm workspace packages:

| Package | Name | Type | Port | Purpose |
|---------|------|------|------|---------|
| `packages/shared` | `@armada/crowdfund-shared` | Library | — | Data layer, event types, graph logic, shared view components |
| `packages/observer` | `@armada/crowdfund-observer` | Vite app | 5173 | Read-only crowdfund visualization (tree + table + stats) |
| `packages/committer` | `@armada/crowdfund-committer` | Vite app | 5174 | Participant actions: commit USDC, invite, claim ARM/refunds |
| `packages/admin` | `@armada/crowdfund-admin` | Vite app | 5175 | Launch team & security council operations |

## Specs

Each app implements a spec in the project `.context/` directory. **Read the spec before modifying the corresponding package:**

- Observer: `../../.context/CROWDFUND_OBSERVER.md`
- Committer: `../../.context/CROWDFUND_COMMITTER.md`
- Admin: `../../.context/CROWDFUND_ADMIN.md`

## Architecture

The **shared** package is a TypeScript library (no Vite, no build step). It exports source directly (`"main": "src/index.ts"`), and each consuming app's Vite bundler compiles it. This means changes to shared are reflected immediately in any running app's dev server — no rebuild needed.

The three apps import from shared via `@armada/crowdfund-shared`. npm workspaces resolves this to the local package.

**Observer** is both a standalone app and a component library. Its view components (StatsBar, TreeView, TableView) live in shared so the Committer can embed them. The Observer app wires these components into a standalone layout with its own data fetching.

**Committer** embeds the Observer's view components as a read-only left panel and adds a wallet-connected action panel on the right.

**Admin** does NOT embed Observer components. It has its own simpler participant table and event log, focused on launch-team operations.

## Development

```bash
# From project root (not crowdfund-ui/)
npm install --legacy-peer-deps       # Link all workspace packages
npm run crowdfund:observer           # Start observer on port 5173
npm run crowdfund:committer          # Start committer on port 5174
npm run crowdfund:admin              # Start admin on port 5175
```

Each app loads deployment manifests (contract addresses, ABIs) from `../../deployments/` via a Vite dev server plugin. Contracts must be deployed first (`npm run setup` from the project root).

## Style Reference

All three apps share the same visual theme — dark mode, oklch color tokens, Inter font. The theme CSS is copied from `../../crowdfund-frontend/src/index.css`. shadcn/ui (New York style) provides base UI primitives. Each app has its own shadcn installation (`components.json` + `src/components/ui/`).

## Conventions

- All source files must start with two-line ABOUTME comments (project convention)
- ethers v6 for contract interaction (not viem — matches the existing codebase)
- Jotai for state management
- Tailwind v4 via `@tailwindcss/vite` plugin
- TypeScript strict mode
- `npm install --legacy-peer-deps` is required (Railgun SDK peer dep conflicts in the root project)
