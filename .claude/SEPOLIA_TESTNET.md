# Sepolia Testnet Deployment

Branch: `feat/sepolia-testnet`

## Architecture

Single codebase, environment-driven configuration. No separate branch — contracts are identical, only addresses and config differ.

```
source config/local.env    → local Anvil with mock CCTP
source config/sepolia.env  → Sepolia with real Circle CCTP V2
```

Core config module: `config/networks.ts` — single source of truth for chains, domains, CCTP addresses, and deployment file naming.

## Circle CCTP V2 Testnet Addresses

**Same on all EVM testnets (CREATE2):**
- TokenMessengerV2: `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`
- MessageTransmitterV2: `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`
- TokenMinterV2: `0xb43db544E2c27092c107639Ad201b3dEfAbcF192`

**USDC (per chain):**
- Ethereum Sepolia: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Arbitrum Sepolia: `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`

**Domain IDs:** Ethereum=0, Optimism=2, Arbitrum=3, Base=6

**Iris Attestation API (testnet):** `https://iris-api-sandbox.circle.com`

**USDC Faucet:** `https://faucet.circle.com/` (20 USDC per request, every 2 hours)

---

## Deployment Phases

### Phase 1: Core Privacy Pool + Real CCTP

**Chains:** Ethereum Sepolia (hub) + Base Sepolia (client A)

**Contracts deployed:**
- PrivacyPool + 4 modules (MerkleModule, VerifierModule, ShieldModule, TransactModule) — hub
- PrivacyPoolClient — client
- ArmadaTreasury — hub

**What this validates:**
- Real CCTP V2 `depositForBurnWithHook` round-trip
- Real Circle attestation via Iris API
- Groth16 SNARK proof verification on mainnet-equivalent EVM
- Cross-chain shield (client → hub) and unshield (hub → client) with real USDC
- Fee deduction and treasury collection
- Relayer integration with real attestation polling
- hookData pass-through on real CCTP V2

**This is the highest-risk, highest-value phase.** If the CCTP hook flow works end-to-end with real attestations, the core thesis is validated.

**Commands:**
```bash
source config/sepolia.env
npm run setup:sepolia:phase1
# Or hub only:
npm run setup:sepolia --hub-only
```

---

### Phase 2: Yield Layer with Mock Aave

**Chains:** Ethereum Sepolia (hub only)

**Contracts deployed:**
- MockAaveSpoke (with realistic 5% APY — not 5,000,000% like local dev)
- ArmadaYieldVault
- ArmadaYieldAdapter

**What this validates:**
- Unshield → deposit → yield accrual → withdraw → re-shield flow
- Proof-bound adapter operations (adapter is privileged shield caller)
- Yield fee calculation (10%) and treasury routing
- ERC4626-like vault accounting with real USDC

**Note:** MockAaveSpoke is still a mock because Aave V4 isn't deployed on Sepolia. But it uses real USDC, which is the important difference from local dev. The mock cannot mint yield in real mode (no `addMinter` on real USDC), so it must be pre-funded with USDC to simulate yield.

**Commands:**
```bash
npm run setup:sepolia:phase2
```

---

### Phase 3: Governance + Crowdfund

**Chains:** Ethereum Sepolia (hub only)

**Contracts deployed:**
- ArmadaToken (ARM), VotingLocker, ArmadaGovernor, TimelockController
- TreasurySteward, ArmadaTreasuryGov
- ArmadaCrowdfund (uses real USDC, not a fresh MockUSDCV2)

**What this validates:**
- Token distribution and locking mechanics
- Proposal lifecycle: create → vote → queue → execute
- Timelock-protected treasury operations (shortened to 60s for testnet)
- Steward actions with 30s delay (vs 1 day on mainnet)
- Crowdfund hop mechanics with real USDC contributions

**Independent of CCTP** — can be deployed and tested in parallel with Phase 1 debugging.

**Commands:**
```bash
npm run setup:sepolia:phase3
```

---

### Phase 4: Cross-Chain Linking + Third Chain

**Chains:** All three

**Operations:**
- `setRemotePool` on hub for each client domain
- Configure ArmadaYieldAdapter ↔ PrivacyPool integration
- No `setRemoteTokenMessenger` calls needed (Circle manages this for real CCTP)

**What this validates:**
- 3-chain routing: Arbitrum → Ethereum Hub → Base (and reverse)
- Multi-client domain management
- Full system integration across all chains

**Commands:**
```bash
# Deploy client B first if not done in phase 1
npm run deploy:cctp:sepolia:clientB
npm run deploy:privacy-pool:sepolia:clientB

# Then link everything
npm run setup:sepolia:phase4
```

---

## What CAN Be Tested on Sepolia

| Feature | Status | Notes |
|---|---|---|
| Real CCTP V2 cross-chain burns | Yes | `depositForBurn` + `depositForBurnWithHook` |
| Real attestation flow | Yes | Iris sandbox, 20s fast / 15-19min standard |
| Cross-chain shield/unshield | Yes | Full round-trip with real USDC |
| SNARK proof verification | Yes | Groth16 — pure on-chain math |
| Poseidon Merkle tree | Yes | No external dependencies |
| hookData pass-through | Yes | CCTP V2 testnet supports hooks |
| Governance proposals | Yes | Shortened delays for iteration |
| Crowdfund mechanics | Yes | Real USDC from faucet |
| Treasury & fee collection | Yes | On-chain fee routing |
| Relayer fee calculation | Yes | Real gas pricing |
| Fast vs standard finality | Yes | Test 1000 vs 2000 thresholds |

## What CANNOT Be Tested on Sepolia

| Feature | Reason | Workaround |
|---|---|---|
| Real Aave V4 yield | Not deployed on Sepolia | MockAaveSpoke with realistic rates |
| USDC minting (faucet contract) | Can't `addMinter` on real USDC | Use Circle's web faucet |
| Real yield accumulation | Mock yield is simulated | Pre-fund MockAaveSpoke with USDC |
| Production attestation timing | Testnet congestion differs | Representative but not identical |
| MEV / frontrunning | No economic incentive on testnet | Can't meaningfully test |

## Key Infrastructure Changes

### Relayer: Mock vs Real CCTP

The relayer auto-selects its relay strategy based on `CCTP_MODE`:

- **Mock** (`CCTPRelayModule`): Watches custom indexed `MessageSent` event, constructs MessageV2 bytes, sends with empty attestation
- **Real** (`IrisRelayModule`): Watches `MessageSent(bytes message)` from real MessageTransmitterV2, polls Iris API for attestation, relays with real attestation bytes

### Deployment File Namespacing

Local and testnet deployments coexist in `deployments/`:
```
deployments/
  hub-v3.json                    # Local
  hub-sepolia-v3.json            # Sepolia
  privacy-pool-hub.json          # Local
  privacy-pool-hub-sepolia.json  # Sepolia
```

### Environment-Aware Scripts

All deploy scripts use `config/networks.ts` to:
- Determine chain role from chain ID
- Get correct CCTP domain IDs
- Generate correct deployment filenames
- Skip mock-only operations (like `addMinter`, `setRemoteTokenMessenger`) when using real CCTP

---

## Quick Start

```bash
# 1. Edit config/sepolia.env — set DEPLOYER_PRIVATE_KEY
# 2. Fund deployer with ETH on target chains
# 3. Get testnet USDC from https://faucet.circle.com/

source config/sepolia.env

# Full deployment (all 4 phases)
npm run setup:sepolia

# Or phase by phase
npm run setup:sepolia:phase1    # CCTP + privacy pool
npm run setup:sepolia:phase2    # Yield
npm run setup:sepolia:phase3    # Governance + crowdfund
npm run setup:sepolia:phase4    # Cross-chain linking

# Start relayer with Iris attestation
npm run relayer:sepolia
```
