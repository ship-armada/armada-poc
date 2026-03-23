# Sepolia Testnet Deployment Guide

Deploy and test the Privacy Pool system on Ethereum Sepolia (hub), Base Sepolia (client-a), and Arbitrum Sepolia (client-b) using Circle's real CCTP v2 contracts.

---

## Prerequisites

1. **Private key** — Copy `config/secrets.env.template` to `config/secrets.env` and add your deployer private key
2. **ETH funding** — Fund the deployer address on all target chains:
   - Ethereum Sepolia: https://sepoliafaucet.com/
   - Base Sepolia: https://www.alchemy.com/faucets/base-sepolia
   - Arbitrum Sepolia: https://www.alchemy.com/faucets/arbitrum-sepolia
3. **Testnet USDC** — Get from https://faucet.circle.com/ (20 USDC per request, 2hr cooldown). You need USDC on:
   - Ethereum Sepolia (for hub shield tests)
   - Base Sepolia (for cross-chain shield tests)
4. **Contracts compiled** — `npx hardhat compile`

---

## Step 1: Deploy

### Full deployment (all chains, all components)

```bash
source config/sepolia.env
npm run setup:sepolia
```

This runs 4 phases in order:

| Phase | What it deploys | Networks |
|-------|----------------|----------|
| 1 | CCTP config, PrivacyPool + CCTPHookRouter (hub), PrivacyPoolClient + CCTPHookRouter (clients) | All 3 chains |
| 2 | MockAaveSpoke, ArmadaYieldVault, ArmadaYieldAdapter | Hub only |
| 3 | ArmadaToken, Governor, Timelock, Treasury, Crowdfund | Hub only |
| 4 | Cross-chain linking (remote pools, hookRouter config) | Hub + clients |

### Partial deployment options

```bash
# Phase 1 only (privacy pool + CCTP)
npm run setup:sepolia:phase1

# Phase 4 only (re-link after redeployment)
npm run setup:sepolia:phase4

# Hub chain only (skip client chains)
npm run setup:sepolia:hub-only
```

### What gets saved

Deployment addresses are written to `deployments/`:
- `hub-sepolia-v3.json` — Circle CCTP contract addresses (hub)
- `client-sepolia-v3.json` — Circle CCTP contract addresses (client-a)
- `clientB-sepolia-v3.json` — Circle CCTP contract addresses (client-b)
- `privacy-pool-hub-sepolia.json` — PrivacyPool, modules, hookRouter (hub)
- `privacy-pool-client-sepolia.json` — PrivacyPoolClient, hookRouter (client-a)
- `privacy-pool-clientB-sepolia.json` — PrivacyPoolClient, hookRouter (client-b)
- `yield-hub-sepolia.json` — Yield contracts (hub)

> **Note**: `npm run clean` preserves `*sepolia*` files. Use `npm run clean:all` to wipe everything.

---

## Step 2: Configure the Frontend

After deployment, note the hookRouter addresses from the deploy output or from the deployment JSONs:

```bash
# Extract hookRouter addresses
cat deployments/privacy-pool-hub-sepolia.json | grep hookRouter
cat deployments/privacy-pool-client-sepolia.json | grep hookRouter
```

Edit `usdc-v2-frontend/.env.local`:

```env
VITE_NETWORK=sepolia
VITE_RELAYER_URL=http://localhost:3001
VITE_RELAYER_ADDRESS=<your-deployer-address>
VITE_HUB_HOOK_ROUTER=<hub-hookRouter-address>
VITE_CLIENT_HOOK_ROUTER=<client-a-hookRouter-address>

# Optional: override RPC endpoints
# VITE_SEPOLIA_HUB_RPC=https://ethereum-sepolia-rpc.publicnode.com
# VITE_SEPOLIA_CLIENT_A_RPC=https://base-sepolia-rpc.publicnode.com
# VITE_SEPOLIA_CLIENT_B_RPC=https://arbitrum-sepolia-rpc.publicnode.com
```

---

## Step 3: Start the Relayer

```bash
source config/sepolia.env
npm run relayer:sepolia
```

The relayer auto-detects `CCTP_MODE=real` and uses the Iris attestation module:
- Watches `MessageSent(bytes)` from Circle's real MessageTransmitterV2
- Polls Circle's Iris API (`https://iris-api-sandbox.circle.com`) for attestations
- Calls `hookRouter.relayWithHook(message, attestation)` on the destination chain
- Loads hookRouter addresses from the deployment JSONs automatically

---

## Step 4: Start the Frontend

```bash
cd usdc-v2-frontend
VITE_NETWORK=sepolia npm run dev
```

---

## Step 5: Smoke Tests

```bash
source config/sepolia.env

# Read-only connectivity checks (no USDC spent)
npm run test:sepolia -- --check

# Hub shield test (costs ~1 USDC on Ethereum Sepolia)
npm run test:sepolia -- --shield

# Cross-chain shield test (costs ~1 USDC on Base Sepolia, requires relayer running)
npm run test:sepolia -- --cross-chain

# Run all checks
npm run test:sepolia
```

### What the smoke tests verify

| Test | What it checks |
|------|---------------|
| `--check` | Contract connectivity, verification keys loaded, remote pools configured, USDC balances |
| `--shield` | Hub shield: approve USDC, shield, verify merkle root changed, verify treasury received fee |
| `--cross-chain` | Cross-chain shield: burn on Base Sepolia, CCTP message sent, relayer relays, hub commitment inserted |

---

## What to Test from the Frontend

1. **Direct hub shield** — Connect wallet to Ethereum Sepolia, shield USDC. Should complete in ~1-2 minutes.
2. **Cross-chain shield (client -> hub)** — Connect to Base Sepolia, shield USDC. The tracker should show:
   - Phase 1: Burn tx confirmed on Base Sepolia
   - Phase 2: MessageSent extracted, Iris attestation polling
   - Phase 3: Relay detected on hub chain (shielded balance increases)
3. **Cross-chain unshield (hub -> client)** — Unshield from hub to Base Sepolia.
4. **Private transfer** — Transfer shielded USDC to another Railgun address on the hub.

### Timing expectations

| Operation | Expected time |
|-----------|--------------|
| Iris attestation (fast finality) | ~20 seconds |
| Iris attestation (standard finality) | 15-19 minutes |
| Relayer relay | Near-instant once attestation ready |
| Frontend poll interval | 10 seconds |

---

## Architecture: Real CCTP vs Local Mock

| | Sepolia | Local |
|---|---------|-------|
| CCTP contracts | Circle's real CCTP v2 | MockCCTPV2 |
| USDC | Real testnet USDC | MockUSDCV2 |
| Attestation | Circle Iris API | None (instant) |
| TokenMessenger config | Circle-managed (immutable) | Manual `setRemoteTokenMessenger` |
| Relayer module | `IrisRelayModule` | `CCTPRelayModule` |
| Hook dispatch | CCTPHookRouter (required — real CCTP doesn't auto-dispatch) | CCTPHookRouter (mock also doesn't auto-dispatch) |

---

## Redeployment (after code changes)

If you change contract code and need to redeploy:

```bash
source config/sepolia.env
npx hardhat compile

# Redeploy privacy pool + hookRouter on all chains
npm run setup:sepolia:phase1

# Re-link (sets hookRouter, remote pools, etc.)
npm run setup:sepolia:phase4

# Update frontend env with new hookRouter addresses
cat deployments/privacy-pool-hub-sepolia.json | grep hookRouter
cat deployments/privacy-pool-client-sepolia.json | grep hookRouter
# Edit usdc-v2-frontend/.env.local with new addresses

# Restart relayer (picks up new deployment JSONs)
npm run relayer:sepolia
```

What does NOT need redeployment:
- Circle's CCTP contracts (immutable, managed by Circle)
- CCTP config JSONs (`hub-sepolia-v3.json`, etc.) — only if you haven't run `clean:all`
- Yield/governance contracts — unless those changed too

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `DEPLOYER_PRIVATE_KEY is required` | `source config/sepolia.env` — ensure `config/secrets.env` exists |
| Insufficient ETH | Fund deployer on the failing chain |
| Insufficient USDC | https://faucet.circle.com/ (20 per request, 2hr cooldown) |
| Relayer not relaying | Check deployment JSONs exist and contain `hookRouter` |
| Attestation timeout | Iris sandbox can be slow; check API health manually |
| Frontend not tracking relay | Verify `VITE_HUB_HOOK_ROUTER` / `VITE_CLIENT_HOOK_ROUTER` set in `.env.local` |
| `Invalid merkleroot` in SDK | Ensure `VITE_NETWORK=sepolia` is set (prevents SDK QuickSync from loading real Sepolia commitments) |
| Deployment files missing | Run `npm run setup:sepolia:phase1` to recreate. `npm run clean` preserves sepolia files; `npm run clean:all` does not. |
