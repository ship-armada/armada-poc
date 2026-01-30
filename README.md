# Railgun CCTP POC

A proof-of-concept demonstrating **cross-chain privacy** by combining Railgun's ZK-based shielded pool with CCTP-style USDC bridging.

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
│  User USDC ◀─────────────── CCTP ─────│  Unshield                      │
│                      │                 │                                │
└──────────────────────┘                 └────────────────────────────────┘
```

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
│   ├── PrivacyPool.sol     # Hub chain shielded pool
│   ├── PrivacyPoolClient.sol # Client chain entry point
│   ├── MockUSDC.sol        # CCTP simulation (burn/mint)
│   ├── Faucet.sol          # Test token faucet
│   └── yield/              # Yield vault contracts
├── usdc-v2-frontend/       # React demo application
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

**Fresh start**
```bash
# Stop all terminals, then:
npm run clean
# Restart from step 2
```
