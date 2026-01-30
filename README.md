# Railgun CCTP POC

A proof-of-concept demonstrating **cross-chain privacy** by combining Railgun's ZK-based shielded pool with CCTP-style USDC bridging.

## What This Demonstrates

Three complete privacy flows using real cryptography:

| Flow | Description |
|------|-------------|
| **Shield** | Deposit USDC on any chain → Bridge to hub → Create shielded commitment in Railgun |
| **Transfer** | Move value privately within the shielded pool (ZK proof nullifies inputs, creates new outputs) |
| **Unshield** | ZK proof to withdraw → Bridge back to any chain → Receive USDC |

### Architecture

```
Client Chain                              Hub Chain
┌──────────────────────┐                 ┌────────────────────────────────┐
│                      │                 │                                │
│  User USDC ────────────── Shield ─────▶│  RailgunSmartWallet            │
│       │              │    (relayer)    │  ┌────────────────────────┐    │
│       │              │                 │  │ Poseidon Merkle Tree   │    │
│  ClientShieldProxyV2 │                 │  │ Groth16 Verification   │    │
│       │              │                 │  │ Commitment Storage     │    │
│       ▼              │                 │  └────────────────────────┘    │
│  MockUSDC.burn()     │                 │           │                    │
│                      │                 │     Transfer (private)         │
│                      │                 │           │                    │
│  User USDC ◀──────────── Unshield ────│  HubUnshieldProxy              │
│                      │    (relayer)    │                                │
└──────────────────────┘                 └────────────────────────────────┘
```

## Cryptography

This POC uses the Railgun contracts and circuits for prototyping:

| Component | Implementation |
|-----------|----------------|
| Hash Function | Poseidon (BN254 curve) via circomlibjs |
| Signatures | EdDSA over BabyJubJub curve |
| ZK Proofs | Groth16 SNARKs via snarkjs |
| Merkle Tree | Incremental Poseidon tree (depth 16) |
| Commitments | `Poseidon(npk, token, value)` |
| Nullifiers | `Poseidon(nullifyingKey, leafIndex)` |

## Quick Start

### Prerequisites

- Node.js 18+
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for Anvil)

### Step 1: Install Dependencies

```bash
npm install --legacy-peer-deps
```

> **Note:** The `--legacy-peer-deps` flag is required due to conflicting peer dependencies between the Railgun SDK (`ethers@6.13.1`) and Hardhat toolbox (`ethers@^6.14.0`).

### Step 2: Start Local Chains

Open a terminal and run:

```bash
npm run chains
```

This starts two Anvil instances:
- **Client chain**: `localhost:8545` (chain ID: 31337)
- **Hub chain**: `localhost:8546` (chain ID: 31338)

Keep this terminal open.

### Step 3: Deploy Contracts

In a new terminal:

```bash
npm run setup
```

This compiles and deploys:
- MockUSDC on both chains (with test tokens minted)
- RailgunSmartWallet with Poseidon libraries, Treasury, and Verifier
- Verification keys for circuits (1x2, 2x2, 2x3, 8x4)
- ClientShieldProxyV2 on client chain
- HubCCTPReceiverV2 on hub chain
- HubUnshieldProxy for cross-chain withdrawals

Deployment addresses are saved to `deployments/*.json`.

### Step 4: Start Relayer

In a new terminal:

```bash
npm run relayer
```

The relayer watches for burn events on both chains and relays messages. Keep this running.

### Step 5: Run the Full Flow

In a new terminal, run all three tests:

```bash
npm run test:all
```

Or run individually:

```bash
npm run test:shield      # 1. Shield: Client USDC → Railgun commitment
npm run test:transfer    # 2. Transfer: Private transfer within pool
npm run test:unshield    # 3. Unshield: Railgun → Client USDC
```

## What Each Test Does

### test:shield
1. Generates a Railgun wallet (spending key, nullifying key, NPK)
2. Creates a ShieldRequest with Poseidon-based commitment
3. Calls `ClientShieldProxyV2.shield()` which burns USDC
4. Relayer picks up burn event, calls hub's `receiveMessage()`
5. `HubCCTPReceiverV2` mints USDC and calls `RailgunSmartWallet.shield()`
6. Commitment is added to Railgun's Poseidon merkle tree

### test:transfer
1. Loads the shielded note from the shield test
2. Builds circuit inputs (merkle proof, nullifier, new commitments)
3. Generates Groth16 ZK proof via snarkjs
4. Calls `RailgunSmartWallet.transact()` with proof
5. Contract verifies proof on-chain, nullifies input, adds new commitments

### test:unshield
1. Loads notes from previous tests
2. Builds unshield transaction with ZK proof
3. Calls `RailgunSmartWallet.transact()` with `unshield=REDIRECT`
4. Contract verifies proof, sends USDC to `HubUnshieldProxy`
5. `HubUnshieldProxy` burns USDC for cross-chain transfer
6. Relayer picks up burn, mints USDC to recipient on client chain

## Project Structure

```
poc/
├── contracts/
│   ├── MockUSDC.sol              # CCTP simulation (burn/mint with callbacks)
│   ├── ClientShieldProxyV2.sol   # Shield entry point on client chain
│   ├── HubCCTPReceiverV2.sol     # Receives bridged funds, shields to Railgun
│   ├── HubUnshieldProxy.sol      # Bridges unshielded funds to other chains
│   └── railgun/                  # Real Railgun contracts
│       ├── logic/
│       │   ├── RailgunSmartWallet.sol  # Main shielded pool
│       │   ├── Verifier.sol            # Groth16 verification
│       │   └── Commitments.sol         # Merkle tree logic
│       ├── proxy/                      # Upgradeable proxy
│       └── treasury/                   # Fee collection
├── lib/
│   ├── sdk/                # SDK-based modules (recommended)
│   │   ├── index.ts        # Central exports
│   │   ├── init.ts         # Engine initialization with LevelDB
│   │   ├── chain-config.ts # Chain configuration
│   │   ├── wallet.ts       # BIP39 mnemonic wallet management
│   │   ├── shield.ts       # Shield request generation
│   │   ├── network.ts      # Network loading and merkle sync
│   │   ├── prover.ts       # SDK prover with snarkjs
│   │   ├── transfer.ts     # High-level transfer/unshield API
│   │   └── test-*.ts       # Module unit tests
│   ├── _legacy/            # Legacy manual implementations
│   │   ├── wallet.ts       # Manual key derivation
│   │   ├── merkle_tree.ts  # Client-side Poseidon tree
│   │   ├── prover.ts       # Direct snarkjs proofs
│   │   ├── transfer.ts     # Manual UTXO management
│   │   └── shield_request.ts
│   └── artifacts.ts        # Verification key loading
├── test/
│   ├── e2e_shield_sdk.ts         # Shield flow with SDK
│   ├── e2e_transfer_sdk.ts       # Transfer flow with SDK
│   ├── e2e_unshield_sdk.ts       # Unshield flow with SDK
│   ├── e2e_shield_v2.ts          # Shield flow (legacy)
│   ├── e2e_transfer_v2.ts        # Transfer flow (legacy)
│   └── e2e_crosschain_unshield.ts # Unshield flow (legacy)
├── relayer/
│   ├── relay.ts            # Bidirectional CCTP message relay
│   └── config.ts           # Chain RPC and account config
├── scripts/
│   ├── setup_chains.sh     # Start Anvil instances
│   ├── deploy_hub.ts       # Deploy MockUSDC to hub
│   ├── deploy_client.ts    # Deploy MockUSDC to client
│   ├── deploy_railgun.ts   # Deploy Railgun contracts + vkeys
│   ├── deploy_unshield_proxy.ts
│   ├── deploy_v2.ts        # Deploy V2 bridge contracts
│   └── link_deployments.ts # Connect client to hub
├── deployments/            # Generated contract addresses (JSON)
├── wallets/                # Generated test wallet keys (JSON)
├── notes/                  # Generated note data between tests (JSON)
└── data/                   # SDK database storage (LevelDB)
```

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run chains` | Start two local Anvil chains |
| `npm run setup` | Compile + deploy all contracts |
| `npm run relayer` | Start the CCTP message relayer |
| `npm run test:shield` | Test cross-chain shield flow (legacy) |
| `npm run test:transfer` | Test private transfer with ZK proof (legacy) |
| `npm run test:unshield` | Test cross-chain unshield flow (legacy) |
| `npm run test:all` | Run all three legacy tests in sequence |
| `npm run test:sdk:shield` | Test shield flow with SDK modules |
| `npm run test:sdk:transfer` | Test transfer flow with SDK modules |
| `npm run test:sdk:unshield` | Test unshield flow with SDK modules |
| `npm run test:sdk:all` | Run all SDK tests in sequence |
| `npm run test:sdk:modules` | Run SDK module unit tests |
| `npm run clean` | Remove deployments and build artifacts |

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Commitment** | `Poseidon(npk, token, value)` - represents a shielded note in the merkle tree |
| **NPK** | Note Public Key - `Poseidon(masterPubKey, random)` - identifies note owner |
| **Nullifier** | `Poseidon(nullifyingKey, leafIndex)` - revealed when spending to prevent double-spend |
| **Shield** | Deposit tokens, create commitment (no ZK proof needed) |
| **Transfer** | Spend notes privately (ZK proof: "I know preimages that hash to these nullifiers and produce these new commitments") |
| **Unshield** | Withdraw to public address (ZK proof + withdrawal preimage) |

## SDK Integration

This POC now includes integration with the official Railgun SDK (`@railgun-community/engine`). The SDK modules in `lib/sdk/` provide:

| Feature | Description |
|---------|-------------|
| **BIP39 Wallets** | Mnemonic-based wallet creation with proper key derivation |
| **Engine Initialization** | LevelDB-backed persistent storage |
| **Shield Requests** | Proper NPK generation and note encryption |
| **Merkle Tree Sync** | Engine-managed UTXO merkle tree |
| **Proof Generation** | SDK prover with snarkjs integration |
| **Balance Scanning** | Query spendable balances via viewing keys |

To use SDK modules in your code:
```typescript
import {
  initializeEngine,
  createWallet,
  createShieldRequest,
  createPrivateTransfer,
  getSpendableBalance
} from './lib/sdk';
```

See [RAILGUN_SDK.md](RAILGUN_SDK.md) for detailed implementation notes.

## POC Simplifications

This POC makes several simplifications compared to production Railgun:

| Aspect | POC | Production |
|--------|-----|------------|
| **Bridge** | MockUSDC with simple burn/mint | Real CCTP with Circle attestations |
| **Relayer** | Single trusted process | Decentralized network with incentives |
| **Circuits** | 4 verification keys (1x2, 2x2, 2x3, 8x4) | Full set for all input/output combinations |
| **Note Encryption** | SDK handles encryption (test artifacts) | Full ECIES with recipient viewing key |
| **Token Support** | USDC only | Any ERC20/721/1155 |
| **Fees** | Zero | Shield/unshield/transfer fees |

## Files Generated During Tests

| File | Purpose |
|------|---------|
| `deployments/hub.json` | Hub chain contract addresses |
| `deployments/client.json` | Client chain contract addresses |
| `deployments/railgun.json` | Railgun contract addresses and config |
| `wallets/alice.json` | Test wallet keys (Alice) - legacy tests |
| `wallets/bob.json` | Test wallet keys (Bob) - legacy tests |
| `wallets/*.json` | SDK wallet data (mnemonic, railgun address) |
| `notes/shielded_note_v2.json` | Note data from shield test (used by transfer/unshield) |
| `notes/shielded_note_sdk.json` | Note data from SDK shield test |
| `data/railgun-db/` | SDK LevelDB database (wallet state, merkle tree) |

## Troubleshooting

**npm install fails with ERESOLVE peer dependency error**
- Use `npm install --legacy-peer-deps` (required due to ethers version conflicts)

**Tests fail with "deployment not found"**
- Run `npm run setup` first to deploy contracts

**Tests fail with "relayer not running"**
- Start relayer in separate terminal: `npm run relayer`

**Tests timeout waiting for commitment**
- Check relayer terminal for errors
- Ensure both Anvil chains are running (`npm run chains`)

**"Verifier: Key not set" error**
- The circuit size isn't supported. POC only loads 1x2, 2x2, 2x3, 8x4 verification keys.

**Fresh start**
- Stop all terminals
- Run `npm run clean`
- Restart from Step 2
