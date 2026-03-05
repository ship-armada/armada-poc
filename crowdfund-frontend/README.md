# Crowdfund Testing Frontend

Standalone React web app for manually testing the ArmadaCrowdfund smart contracts. Supports both local Anvil chains (with mock USDC) and Sepolia testnet (with real Circle USDC).

## Quick Start

```bash
# 1. Start local chains and deploy contracts
npm run chains
npm run setup

# 2. Start the crowdfund UI (port 5174)
npm run crowdfund-ui
```

Open http://localhost:5174. The UI auto-connects to the local Anvil chain and selects the admin account.

## Features

- **Account selector** — Switch between 10 pre-labeled Anvil accounts (admin, seeds, hop-1, hop-2) with copy-to-clipboard. On Sepolia, connect via MetaMask.
- **Sale status dashboard** — Phase badge, countdown timers, progress bar (with MIN/MAX markers), per-hop stats table.
- **Admin panel** (admin only) — Add seeds, start invitations, finalize sale, withdraw proceeds/ARM. Includes "Fill Anvil Seeds" quick-add button.
- **Participant panel** — View status, send invitations, commit USDC (with auto-approve), claim allocations, request refunds.
- **Time controls** (admin, local only) — Skip to commitment window, skip past commitment, custom time advance via `evm_increaseTime`.
- **Participants table** — Lists all whitelisted addresses with hop, committed amount, and invite count.
- **Event log** — Color-coded reverse-chronological feed of all contract events.
- **USDC faucet** (local only) — Mint mock USDC via the header button (calls deployer-signed `MockUSDCV2.mint()`).

## Testing a Full Lifecycle (Manual)

1. **Setup** — As admin, add seed addresses and click "Start Invitations".
2. **Invitation** — Switch to a seed account, invite hop-1 addresses using the address input.
3. **Commitment** — Click "Skip to Commitment" in time controls. Mint USDC, then enter an amount and click "Commit".
4. **Finalize** — Click "Skip Past Commitment", then switch to admin and click "Finalize Sale".
5. **Claim** — Switch to a participant account and click "Claim" to receive ARM tokens + USDC refund.

## Reaching the $1M Minimum (Populate Script)

The crowdfund has a $1,000,000 minimum raise. With only 10 Anvil accounts in the UI ($60K max), you can't reach this manually. Use the populate script to fill the crowdfund with enough commitments:

```bash
# Default: reach just above MIN_SALE ($1.05M, 70 seeds)
npm run crowdfund:populate

# Reach BASE_SALE ($1.2M)
TARGET=1200000 npm run crowdfund:populate

# Trigger elastic expansion to MAX_SALE ($1.8M)
TARGET=1800000 npm run crowdfund:populate

# Include hop-1 and hop-2 participants (not just seeds)
HOPS=true npm run crowdfund:populate
```

The script uses Hardhat's auto-generated signers (accounts 11-200) as ephemeral participants. It runs the full lifecycle through commitment, leaving the contract ready for you to finalize via the UI.

**After running the populate script:**
1. Open the UI — sale status shows "Commitment expired — ready to finalize"
2. As admin, click "Finalize Sale"
3. Switch to any participant account to test claiming allocations

## Sepolia

Set `VITE_NETWORK=sepolia` in the environment before starting the dev server:

```bash
VITE_NETWORK=sepolia npm run crowdfund-ui
```

On Sepolia, the USDC faucet and time controls are disabled. Connect via MetaMask. Contracts must be deployed first (`npm run deploy:crowdfund:sepolia`).

## Tech Stack

React 19, Vite 7, TypeScript, Tailwind CSS v4, Jotai, shadcn/ui, ethers v6, Sonner (toasts).

## Development

```bash
cd crowdfund-frontend

# Dev server (port 5174)
npm run dev

# Type check
npx tsc -b --noEmit

# Unit tests (36 tests)
npx vitest run

# Production build
npm run build
```
