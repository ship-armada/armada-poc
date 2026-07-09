# Armada

**Cross-chain privacy with shielded yield** — a Railgun-style ZK shielded pool combined with Circle's CCTP for cross-chain USDC bridging and DeFi yield integration.

The project is transitioning from POC to production and ships in two launches:

1. **Crowdfund + Governance** (near-term) — the token sale and on-chain governance stack. Apps live in `crowdfund-ui/` (committer, admin); see `specs/` for the governance, crowdfund, and operations specs.
2. **Shielded Pool** (later) — the privacy pool, yield vault, fee module, and the `apps/armada-interface` user app. Deploys after the sale via governance proposals.

This README covers the **local privacy-pool + shielded-yield demo**. For the crowdfund/governance apps and their deploy flows, see `CLAUDE.md`, `crowdfund-ui/`, and `specs/`.

## Quick Start

### Prerequisites

- Node.js 20+
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for Anvil local chains)
  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```
- MetaMask or similar browser wallet

### Setup & Run

```bash
# 1. Install dependencies(Atm might need some legacy dep support to avoid npm errors)
npm install --legacy-peer-deps

# 2. Set permissions
chmod +x ./scripts/setup_chains.sh

# 3. Start local chains (3 Anvil instances)
npm run chains

# 4. In a new terminal: compile & deploy contracts
npm run setup

# 5. Start the Armada Relayer (HTTP fee API + CCTP relay)
npm run armada-relayer

# 6. In a new terminal: start the demo app
#    (npm run demo runs the deprecated usdc-v2-frontend, retained as the working
#     local privacy-pool demo until apps/armada-interface's flows are wired for local)
npm run demo

# 7. Open http://localhost:5173 in your browser
```

### Add Local Chains to MetaMask

| Chain | RPC URL | Chain ID |
|-------|---------|----------|
| Hub | `http://localhost:8545` | `31337` |
| Client A | `http://localhost:8546` | `31338` |
| Client B | `http://localhost:8547` | `31339` |

Use the **Debug** page in the app to get test USDC and ETH from the faucet.

## What This Demonstrates

Cross-chain privacy flows using real ZK cryptography:

| Flow | Description |
|------|-------------|
| **Shield** | Deposit USDC on any chain → Bridge to hub → Create shielded commitment |
| **Transfer** | Move value privately within the shielded pool (ZK proof) |
| **Unshield** | ZK proof to withdraw → Bridge back to any chain → Receive USDC |
| **Shielded Lend** | Deposit shielded USDC into yield vault → Receive shielded ayUSDC |
| **Shielded Withdraw** | Redeem shielded ayUSDC → Receive shielded USDC + yield |

### Architecture

```
Client Chain A/B                          Hub Chain
┌──────────────────────┐                 ┌────────────────────────────────┐
│                      │                 │                                │
│  User USDC ─────────────── CCTP ──────▶│  PrivacyPool                   │
│                      │                 │  ┌────────────────────────┐    │
│  PrivacyPoolClient   │                 │  │ Poseidon Merkle Tree   │    │
│                      │                 │  │ Groth16 Verification   │    │
│                      │                 │  │ Shielded Commitments   │    │
│                      │                 │  └────────────────────────┘    │
│                      │                 │           │                    │
│                      │                 │     Transfer (private)         │
│                      │                 │           │                    │
│                      │                 │     ┌─────▼─────────────┐     │
│                      │                 │     │ ArmadaYieldAdapter │     │
│                      │                 │     └─────┬─────────────┘     │
│                      │                 │           │                    │
│                      │                 │  ┌────────▼────────┐           │
│                      │                 │  │ ArmadaYieldVault │           │
│                      │                 │  │ (ayUSDC shares)  │           │
│                      │                 │  └────────┬────────┘           │
│                      │                 │           │                    │
│                      │                 │     MockAaveSpoke              │
│                      │                 │     (Yield Source)             │
│                      │                 │           │                    │
│  User USDC ◀─────────────── CCTP ─────│  Unshield                      │
│                      │                 │                                │
└──────────────────────┘                 └────────────────────────────────┘
```

## Shielded Yield

The POC includes a complete shielded yield system that allows users to earn yield on their shielded assets without revealing their identity or balance.

### How It Works

1. **Shielded Lend**: User's shielded USDC is atomically unshielded, deposited into the yield vault, and the resulting ayUSDC shares are shielded back - all in a single ZK-proven transaction.

2. **Yield Accrual**: The ArmadaYieldVault is a non-rebasing ERC4626 vault. Share quantities stay constant while share value increases over time.

3. **Shielded Withdraw**: User's shielded ayUSDC is atomically unshielded, redeemed from the vault, and the resulting USDC (principal + yield) is shielded back.

4. **Fee Collection**: A 10% yield fee is collected on withdrawal and sent to the governance-controlled treasury (`ArmadaTreasuryGov`).

### Cross-Contract Calls (ArmadaYieldAdapter)

Shielded yield uses the Railgun SDK's adapt pattern via `ArmadaYieldAdapter`:

```
┌─────────────────────────────────────────────────────────────────┐
│              ArmadaYieldAdapter.lendAndShield / redeemAndShield  │
│  1. Unshield tokens from PrivacyPool → Adapter receives          │
│  2. Deposit/redeem on vault (USDC ↔ ayUSDC)                      │
│  3. Shield resulting tokens back to user (proof-bound npk)       │
└─────────────────────────────────────────────────────────────────┘
```

The proof commits `adaptParams = hash(npk, encryptedBundle, shieldKey)`, so the adapter cannot deviate from the user's intended shield destination. This enables trustless DeFi interactions while maintaining privacy.

### Yield Contracts

| Contract | Description |
|----------|-------------|
| `ArmadaYieldVault` | ERC4626 vault wrapping Aave, issues non-rebasing ayUSDC shares |
| `ArmadaYieldAdapter` | Trustless bridge: unshield → deposit/redeem → shield (adaptParams binds destination) |
| `ArmadaTreasuryGov` | Governance-controlled treasury (in `contracts/governance/`) — receives 10% yield fees |
| `MockAaveSpoke` | Simulated Aave V4 spoke for local testing |

### Real-Time Yield Display

The frontend dynamically updates yield values using a hybrid approach:
- **Polling**: Exchange rate fetched every 30 seconds
- **Event-driven**: Immediate refresh on vault Deposit/Withdraw events

This ensures the dashboard shows accurate yield even though yield accrues passively without on-chain events for individual users.

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run chains` | Start 3 local Anvil chains (hub + 2 clients) |
| `npm run setup` | Compile & deploy all contracts |
| `npm run armada-relayer` | Start the unified relayer (HTTP fee API + CCTP relay) |
| `npm run relayer` | Start legacy CCTP-only relay (no HTTP API) |
| `npm run demo` | Start the frontend demo app |
| `npm run test` | Run integration tests |
| `npm run clean` | Remove deployments and build artifacts |

## Cryptography

| Component | Implementation |
|-----------|----------------|
| Hash Function | Poseidon (BN254 curve) |
| Signatures | EdDSA over BabyJubJub curve |
| ZK Proofs | Groth16 SNARKs via snarkjs |
| Merkle Tree | Incremental Poseidon tree (depth 16) |
| Commitments | `Poseidon(npk, token, value)` |
| Nullifiers | `Poseidon(nullifyingKey, leafIndex)` |

## Project Structure

```
poc/
├── contracts/              # Solidity contracts
│   ├── privacy-pool/       # Hub chain shielded pool
│   │   ├── PrivacyPool.sol
│   │   └── modules/        # Modular pool components
│   ├── client/             # Client chain contracts
│   │   └── PrivacyPoolClient.sol
│   ├── yield/              # Yield vault contracts
│   │   ├── ArmadaYieldVault.sol
│   │   ├── ArmadaYieldAdapter.sol
│   │   └── MockAaveSpoke.sol
│   ├── governance/         # Governance, treasury, crowdfund, revenue contracts
│   ├── fees/               # ArmadaFeeModule (volume tiers, integrators)
│   ├── MockUSDC.sol        # CCTP simulation (burn/mint)
│   └── Faucet.sol          # Test token faucet
├── apps/
│   └── armada-interface/   # User app — shield/unshield/yield/payments (Launch 2)
├── crowdfund-ui/           # Crowdfund committer + admin apps (Launch 1)
├── governance-ui/          # Standalone governance proposal builder
├── packages/               # Shared workspace packages (@armada/ui design system)
├── usdc-v2-frontend/       # Deprecated demo frontend — used by `npm run demo`
├── relayer/                # CCTP message relay + HTTP fee API
├── scripts/                # Deployment scripts
├── tasks/                  # Hardhat CLI tasks (crowdfund, governance)
├── specs/                  # Specifications (governance, crowdfund, fees, ops)
├── deploy/                 # Crowdfund indexer deployment infra
├── deployments/            # Generated contract addresses
└── lib/                    # SDK integration modules
```

## Troubleshooting

**Tests fail with "deployment not found"**
- Run `npm run setup` first to deploy contracts

**Relayer errors or transactions not completing**
- Ensure the Armada Relayer is running: `npm run armada-relayer`
- Check that all 3 Anvil chains are running

**Frontend shows `ERR_CONNECTION_REFUSED` on `/fees`**
- The frontend requires the Armada Relayer's HTTP API (`localhost:3001`)
- Make sure you started `npm run armada-relayer`, **not** `npm run relayer` — the legacy `relayer` script has no HTTP API

**Frontend shows "Error Loading Stats"**
- Chains may not be running - start with `npm run chains`
- Contracts may not be deployed - run `npm run setup`

**Shielded lend/withdraw fails**
- Ensure you have shielded USDC (for lend) or shielded ayUSDC (for withdraw)
- Check browser console for detailed error messages
- Verify ArmadaYieldAdapter is deployed: check Debug page for contract addresses

**Yield not updating**
- The dashboard polls every 30 seconds; wait or trigger a vault event
- Lock/unlock the shielded wallet to force a balance refresh

**Fresh start**
```bash
# Stop all terminals, then:
npm run clean
# Restart from step 2
```
