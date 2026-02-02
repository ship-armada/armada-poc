# Railgun CCTP POC

A proof-of-concept demonstrating **cross-chain privacy with shielded yield** by combining Railgun's ZK-based shielded pool with CCTP-style USDC bridging and DeFi integrations.

## Quick Start

### Prerequisites

- Node.js 18+
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for Anvil local chains)
  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```
- MetaMask or similar browser wallet

### Setup & Run

```bash
# 1. Install dependencies
npm install

# 2. Start local chains (3 Anvil instances)
npm run chains

# 3. In a new terminal: compile & deploy contracts
npm run setup

# 4. Start the CCTP message relayer
npm run relayer

# 5. In a new terminal: start the demo app
npm run demo

# 6. Open http://localhost:5173 in your browser
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
│                      │                 │     ┌─────▼─────┐              │
│                      │                 │     │ RelayAdapt │              │
│                      │                 │     └─────┬─────┘              │
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

4. **Fee Collection**: A 10% yield fee is collected on withdrawal and sent to the ArmadaTreasury.

### Cross-Contract Calls (RelayAdapt)

Shielded yield uses the Railgun SDK's cross-contract calls pattern via `PrivacyPoolRelayAdapt`:

```
┌─────────────────────────────────────────────────────────────────┐
│                    RelayAdapt.relay()                           │
│  1. Unshield tokens from PrivacyPool → RelayAdapt receives      │
│  2. Execute multicall (approve + deposit/redeem on vault)       │
│  3. Shield resulting tokens back to user                        │
└─────────────────────────────────────────────────────────────────┘
```

This enables complex DeFi interactions while maintaining privacy - the proof commits to the entire operation, ensuring atomicity.

### Yield Contracts

| Contract | Description |
|----------|-------------|
| `ArmadaYieldVault` | ERC4626 vault wrapping Aave, issues non-rebasing ayUSDC shares |
| `ArmadaYieldAdapter` | Privileged adapter for fee-free deposits (future use) |
| `ArmadaTreasury` | Collects 10% yield fees on redemptions |
| `MockAaveSpoke` | Simulated Aave V4 spoke for local testing |
| `PrivacyPoolRelayAdapt` | Enables SDK cross-contract calls with PrivacyPool |

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
| `npm run relayer` | Start the CCTP message relayer |
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
│   │   ├── PrivacyPoolRelayAdapt.sol  # Cross-contract calls support
│   │   └── modules/        # Modular pool components
│   ├── client/             # Client chain contracts
│   │   └── PrivacyPoolClient.sol
│   ├── yield/              # Yield vault contracts
│   │   ├── ArmadaYieldVault.sol
│   │   ├── ArmadaYieldAdapter.sol
│   │   ├── ArmadaTreasury.sol
│   │   └── MockAaveSpoke.sol
│   ├── MockUSDC.sol        # CCTP simulation (burn/mint)
│   └── Faucet.sol          # Test token faucet
├── usdc-v2-frontend/       # React demo application
│   ├── src/
│   │   ├── hooks/
│   │   │   ├── useShieldedWallet.ts    # Shielded balance management
│   │   │   ├── useShieldedYieldTransaction.ts  # Lend/withdraw UX
│   │   │   └── useYieldRate.ts         # Real-time yield display
│   │   └── services/
│   │       └── yield/
│   │           └── shieldedYieldService.ts  # SDK integration
├── relayer/                # CCTP message relay service
├── scripts/                # Deployment scripts
├── deployments/            # Generated contract addresses
└── lib/                    # SDK integration modules
```

## Troubleshooting

**Tests fail with "deployment not found"**
- Run `npm run setup` first to deploy contracts

**Relayer errors or transactions not completing**
- Ensure relayer is running: `npm run relayer`
- Check that all 3 Anvil chains are running

**Frontend shows "Error Loading Stats"**
- Chains may not be running - start with `npm run chains`
- Contracts may not be deployed - run `npm run setup`

**Shielded lend/withdraw fails**
- Ensure you have shielded USDC (for lend) or shielded ayUSDC (for withdraw)
- Check browser console for detailed error messages
- Verify RelayAdapt is deployed: check Debug page for contract addresses

**Yield not updating**
- The dashboard polls every 30 seconds; wait or trigger a vault event
- Lock/unlock the shielded wallet to force a balance refresh

**Fresh start**
```bash
# Stop all terminals, then:
npm run clean
# Restart from step 2
```
