# @armada/crowdfund-admin

Privileged interface for the launch team and security council to manage the Armada crowdfund lifecycle: ARM pre-loading, seed management, launch team invites, finalization, cancellation, treasury monitoring, and ARM sweep.

## Spec

**Read this first:** `../../../../.context/CROWDFUND_ADMIN.md`

The spec defines the complete admin surface: role-based access, phase-conditional actions, status dashboard, event log, participant table, treasury monitoring, local dev controls, and all contract functions referenced.

## Architecture

Four sections stacked vertically:
1. **Status Dashboard** — phase, timing, progress bar, per-hop stats, LT budget tracker
2. **Admin Actions Panel** — phase-conditional write operations (gated by connected wallet role)
3. **Event Log** — reverse-chronological event stream with filtering
4. **Participant Table** — sortable, searchable, per-hop or per-address aggregation

This app does NOT embed the Observer's tree visualization. It has its own simpler participant table and event log focused on operational monitoring rather than network visualization.

## Role Gating

The connected wallet determines available actions:
- **Launch Team** — full admin surface (seeds, invites, finalize, sweep)
- **Security Council** — cancel button only, everything else read-only
- **Any other wallet / no wallet** — read-only monitoring (dashboard, events, table)

Roles are detected by comparing the connected address against `launchTeam()` and `securityCouncil()` contract reads.

## Development

```bash
# From project root
npm run crowdfund:admin    # Starts on port 5175

# Or from this directory
npm run dev
```

Requires deployed contracts (`npm run setup` from project root). Includes `mintUsdcEndpoint()` Vite plugin for local USDC minting.

## Dependencies

Current dependencies are the scaffold baseline. When implementing, add:
- `wagmi` + `@rainbow-me/rainbowkit` — wallet connection and role detection
- `viem` — wagmi peer dependency
- `@tanstack/react-table` — participant table with sort/filter

## Key Patterns

- **ethers v6** for contract reads/writes
- **Jotai** for state management
- **Tailwind v4** with shadcn/ui (New York style)
- **`@` path alias** maps to `src/`
- All source files must start with two-line ABOUTME comments
- **Block timestamp** for countdowns (not `Date.now()` — EVM time diverges from wall clock in local mode)

## App-Local Code

**Components** (`src/components/`):
- `StatusDashboard.tsx` — phase, timing, progress bar, per-hop stats
- `AdminActions.tsx` — phase-conditional action panels container
- `SeedManager.tsx` — seed textarea + batch add
- `LaunchTeamInvites.tsx` — LT invite form + budget display
- `FinalizePanel.tsx` — pre-finalization summary + finalize button
- `CancelPanel.tsx` — security council cancel with typed confirmation gate
- `SettlementSummary.tsx` — post-finalization stats
- `TreasuryMonitor.tsx` — treasury balances + ARM sweep
- `EventLog.tsx` — scrollable, filtered event stream
- `ParticipantTable.tsx` — sortable, searchable participant table
- `TransactionFlow.tsx` — shared tx submission UI
- `WalletHeader.tsx` — connected address + role badge + network
- `TimeControls.tsx` — local-only time warp + USDC minting

**Hooks** (`src/hooks/`):
- `useAdminState.ts` — aggregate contract reads, polling
- `useRole.ts` — connected wallet role detection
- `useParticipants.ts` — batched participant data fetching
- `useContractEvents.ts` — event log fetching + incremental updates
- `useTransactionFlow.ts` — submit tx → wait → confirm/error
- `useTreasuryBalances.ts` — ERC-20 balance reads
- `useTimeControls.ts` — local-only evm_increaseTime + evm_mine

## Shared Package Usage

The admin imports only the lib layer from shared (constants, event types, formatting). It does NOT import Observer view components or data-layer hooks.

```ts
import { CROWDFUND_CONSTANTS, CROWDFUND_ABI_FRAGMENTS, formatUsdc, formatArm } from '@armada/crowdfund-shared'
import type { CrowdfundEvent } from '@armada/crowdfund-shared'
```

## Contract Write Functions

| Function | Role | Phase | Notes |
|----------|------|-------|-------|
| `loadArm()` | Permissionless | Active | Verify ARM pre-load. Idempotent. |
| `addSeeds(address[])` | Launch team | Active, pre-week-1-end | Batch seeds. Max 150 total. |
| `launchTeamInvite(address, uint8)` | Launch team | Active, week-1 window | Budget-tracked (60/60). |
| `finalize()` | Permissionless | Active, post-window | Compute allocations, transfer proceeds. |
| `cancel()` | Security council | Active | Emergency cancel. Irreversible. |
| `withdrawUnallocatedArm()` | Permissionless | Finalized or Cancelled | Sweep ARM to treasury. |

## Local Dev Controls

In local mode (Anvil), the admin app provides:
- **Time warp buttons** — skip to week-1 end, window end, claim deadline
- **Custom time advance** — input seconds + advance
- **USDC minting** — via `mintUsdcEndpoint()` Vite plugin
- **Anvil account switcher** — dropdown of pre-configured accounts with role labels

These controls are NEVER shown in non-local environments. Detection is by chain ID or `VITE_NETWORK` env var.
