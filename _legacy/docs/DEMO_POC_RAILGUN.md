# Railgun Integration POC - Implementation Plan

This document outlines the plan to evolve the stub-based POC into a fully functional CCTP + Railgun integration with real ZK proofs.

## Overview

**Goal**: Replace the stub `SimpleShieldAdapter` with real Railgun contracts (`RailgunSmartWallet`) and integrate actual ZK proof generation on the client side.

**Scope**:
- Deploy Railgun smart contracts on hub chain
- Integrate CCTP flow with Railgun's `shield()` function
- Generate real Groth16 proofs client-side via `@railgun-community/engine`
- Replace stub unshield with Railgun's `transact()` with unshield type

---

## 1. Architecture Changes

### Current Architecture (Stub)
```
Client Chain                    Hub Chain
┌──────────────────┐           ┌──────────────────────────┐
│ MockUSDC         │           │ MockUSDC                 │
│ ClientShieldProxy│──CCTP────▶│ HubCCTPReceiver          │
└──────────────────┘           │ SimpleShieldAdapter (STUB)│
                               └──────────────────────────┘
```

### Target Architecture (Real Railgun)
```
Client Chain                    Hub Chain
┌──────────────────┐           ┌────────────────────────────────┐
│ MockUSDC         │           │ MockUSDC                       │
│ ClientShieldProxy│──CCTP────▶│ HubCCTPReceiver                │
└──────────────────┘           │   └─▶ RailgunSmartWallet.shield()│
                               │ RailgunSmartWallet (real SNARK) │
                               │ PoseidonT3, PoseidonT4 libs     │
                               │ Treasury, RelayAdapt            │
                               └────────────────────────────────┘
```

---

## 2. Required Dependencies

### NPM Packages

```json
{
  "dependencies": {
    "@railgun-community/engine": "^X.X.X",
    "@railgun-community/shared-models": "^X.X.X",
    "@railgun-community/wallet": "^X.X.X",
    "snarkjs": "^0.7.0",
    "circomlibjs": "^0.1.7"
  },
  "devDependencies": {
    "railgun-circuit-test-artifacts": "^X.X.X"
  }
}
```

### Contract Dependencies

The Railgun contracts in `/Volumes/T7/railgun/contract` already include:
- OpenZeppelin contracts (via npm)
- Poseidon hash implementations
- Groth16 verifier

---

## 3. Contract Deployment Strategy

### Option A: Use `no_governance.ts` Directly (Recommended for POC)

The existing `contract/tasks/deploy/no_governance.ts` provides a minimal deployment without governance overhead.

**Steps**:
1. Configure Hardhat to target hub chain (localhost:8546, chainId 31338)
2. Deploy MockWETH9 (required by RelayAdapt)
3. Run: `npx hardhat deploy:no_governance --weth9 <WETH9_ADDRESS> --network hub`

**What gets deployed**:
| Contract | Purpose |
|----------|---------|
| `PoseidonT3` | Poseidon hash library (3 inputs) |
| `PoseidonT4` | Poseidon hash library (4 inputs) |
| `Delegator` | Ownership proxy |
| `Treasury` | Fee collection |
| `ProxyAdmin` | Upgrade management |
| `RailgunSmartWallet` (Proxy) | Main shielded pool contract |
| `RelayAdapt` | Relayer integration |

**Initialization**:
- Treasury: 25bp shield fee, 25bp unshield fee, 25bp NFT fee
- Verification keys loaded via `loadArtifacts()` from `railgun-circuit-test-artifacts`

### Option B: Custom Minimal Deployment

Create a stripped-down deployment script for POC:

```typescript
// scripts/deploy_railgun_hub.ts
async function deployRailgun(hubProvider: ethers.Provider) {
  // 1. Deploy Poseidon libraries
  const PoseidonT3 = await deploy("PoseidonT3");
  const PoseidonT4 = await deploy("PoseidonT4");

  // 2. Deploy RailgunSmartWallet with linked libraries
  const RailgunSmartWallet = await ethers.getContractFactory("RailgunSmartWallet", {
    libraries: {
      PoseidonT3: PoseidonT3.address,
      PoseidonT4: PoseidonT4.address
    }
  });

  // 3. Deploy proxy + implementation
  const proxy = await deployProxy(RailgunSmartWallet);

  // 4. Initialize (treasury can be deployer for POC)
  await proxy.initializeRailgunLogic(
    treasuryAddress,
    0, // shieldFee (0 for POC simplicity)
    0, // unshieldFee
    0, // nftFee
    deployerAddress
  );

  // 5. Load verification keys (CRITICAL)
  await loadArtifacts(proxy, listArtifacts());

  return proxy.address;
}
```

---

## 4. Verification Keys Setup

### Testing Subset (Recommended for POC)

The `railgun-circuit-test-artifacts` package provides verification keys for a subset of circuits:

| Nullifiers | Commitments | Use Case |
|------------|-------------|----------|
| 1 | 2 | Shield (1 input → 2 outputs) |
| 2 | 3 | Small transfer |
| 8 | 4 | Medium transfer |
| 12 | 2 | Unshield (many inputs → few outputs) |

```typescript
// From contract/helpers/logic/artifacts.ts
import artifacts from 'railgun-circuit-test-artifacts';

// Load into contract
await loadArtifacts(railgunContract, artifacts.listArtifacts());
```

### Full Artifact Set (Production)

For production, load all 91 circuit variants:
```typescript
await loadArtifacts(railgunContract, artifacts.listArtifacts()); // All variants
```

---

## 5. Integration Points

### 5.1 Shield Flow (CCTP → Railgun)

**Current Stub**:
```solidity
// HubCCTPReceiver.sol
function processShield(bytes32 commitment, uint256 amount, bytes calldata encryptedNote) {
    shieldAdapter.insertCommitment(commitment, amount, encryptedNote);
}
```

**Replacement with Railgun**:
```solidity
// HubCCTPReceiver.sol (modified)
import { ShieldRequest, CommitmentPreimage, ShieldCiphertext } from "RailgunSmartWallet";

function processShield(
    ShieldRequest calldata shieldRequest
) external {
    // Approve USDC to RailgunSmartWallet
    IERC20(usdc).approve(railgunWallet, shieldRequest.preimage.value);

    // Call Railgun shield
    ShieldRequest[] memory requests = new ShieldRequest[](1);
    requests[0] = shieldRequest;
    IRailgunSmartWallet(railgunWallet).shield(requests);
}
```

**Client-side changes**:
```typescript
// lib/note_generator.ts replacement
import { ShieldNoteERC20, RailgunEngine } from '@railgun-community/engine';

async function createShieldRequest(
  amount: bigint,
  recipientRailgunAddress: string,
  shieldPrivateKey: Uint8Array
): Promise<ShieldRequestStruct> {
  const { masterPublicKey, viewingPublicKey } =
    RailgunEngine.decodeAddress(recipientRailgunAddress);

  const random = ByteUtils.randomHex(16);

  const shieldNote = new ShieldNoteERC20(
    masterPublicKey,
    random,
    amount,
    USDC_ADDRESS
  );

  return shieldNote.serialize(shieldPrivateKey, viewingPublicKey);
}
```

### 5.2 Transfer Flow (Private → Private)

**Current Stub**:
```solidity
function transfer(
    bytes32[] calldata inputNullifiers,
    bytes32[] calldata outputCommitments,
    bytes[] calldata encryptedNotes,
    bytes calldata proof  // Ignored in stub
) external;
```

**Replacement with Railgun**:
```solidity
// Use RailgunSmartWallet.transact() directly
function transact(Transaction[] calldata _transactions) external;
```

**Client-side proof generation**:
```typescript
import { Prover } from '@railgun-community/engine';
import { groth16 } from 'snarkjs';

async function generateTransferProof(
  inputs: UnprovedTransactionInputs,
  progressCallback: (progress: number) => void
): Promise<Transaction> {
  const engine = getEngine();
  const prover = engine.prover;

  // Set snarkjs as the Groth16 implementation
  prover.setSnarkJSGroth16(groth16);

  // Generate proof (fetches artifacts automatically)
  const { proof, publicInputs } = await prover.proveRailgun(
    TXIDVersion.V2_PoseidonMerkle,
    inputs,
    progressCallback
  );

  // Format for contract
  return {
    proof: Prover.formatProof(proof),
    merkleRoot: publicInputs.merkleRoot,
    nullifiers: publicInputs.nullifiers,
    commitments: publicInputs.commitmentsOut,
    boundParams: buildBoundParams(...),
    unshieldPreimage: EMPTY_PREIMAGE
  };
}
```

### 5.3 Unshield Flow (Private → CCTP)

**Railgun approach**: Use `transact()` with `UnshieldType.NORMAL` or `UnshieldType.REDIRECT`.

```typescript
// Build transaction with unshield
const transaction: Transaction = {
  proof: generateProof(...),
  merkleRoot: currentRoot,
  nullifiers: [inputNullifier],
  commitments: [changeCommitment],  // Change output if any
  boundParams: {
    treeNumber: 0,
    minGasPrice: 0n,
    unshield: UnshieldType.NORMAL,  // KEY: enables unshield
    chainID: 31338n,
    adaptContract: ethers.ZeroAddress,
    adaptParams: ethers.ZeroHash,
    commitmentCiphertext: [changeCiphertext]
  },
  unshieldPreimage: {
    npk: recipientAddress,  // Recipient gets USDC
    token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0 },
    value: unshieldAmount
  }
};
```

For cross-chain unshield (back to client via CCTP):
1. Unshield to a dedicated bridge contract on hub
2. Bridge contract burns USDC via MockUSDC.burnForDeposit()
3. Relayer picks up burn event, mints on client

---

## 6. Wallet/Engine Setup

### Initialize Engine

```typescript
import {
  RailgunEngine,
  setLoggers,
  ArtifactStore
} from '@railgun-community/engine';

async function initEngine() {
  // Optional: Set up artifact storage
  const artifactStore = new ArtifactStore(
    async (path) => fs.readFileSync(path),
    async (path, data) => fs.writeFileSync(path, data),
    async (path) => fs.existsSync(path)
  );

  // Initialize engine
  await RailgunEngine.initForWallet(
    'test-wallet',
    leveldown('./db'),
    shouldDebug,
    artifactStore,
    useNativeArtifacts,
    skipMerkletreeScans
  );

  // Set snarkjs prover
  const engine = RailgunEngine.getEngine();
  engine.prover.setSnarkJSGroth16(require('snarkjs').groth16);

  return engine;
}
```

### Create/Load Wallet

```typescript
async function createWallet(mnemonic: string): Promise<RailgunWallet> {
  const encryptionKey = ByteUtils.randomHex(32);

  const wallet = await RailgunEngine.createWalletFromMnemonic(
    encryptionKey,
    mnemonic,
    0  // derivation index
  );

  // Get Railgun address
  const railgunAddress = wallet.getAddress();
  // Format: 0zk1...

  return wallet;
}
```

---

## 7. Implementation Steps

### Phase 1: Contract Deployment
- [ ] Deploy MockWETH9 on hub chain
- [ ] Copy Railgun contracts to poc/contracts or set up import path
- [ ] Deploy Railgun contracts using adapted `no_governance.ts`
- [ ] Verify deployment with simple contract reads

### Phase 2: Update Hub Receiver
- [ ] Modify `HubCCTPReceiver.sol` to call `RailgunSmartWallet.shield()`
- [ ] Update relayer to construct proper `ShieldRequest` structs
- [ ] Test shield flow end-to-end

### Phase 3: Client Proof Generation
- [ ] Set up engine initialization
- [ ] Implement wallet creation/loading
- [ ] Implement proof generation for transfers
- [ ] Test transfer flow end-to-end

### Phase 4: Cross-chain Unshield
- [ ] Create bridge adapter contract on hub
- [ ] Implement unshield-to-bridge proof generation
- [ ] Update relayer to handle unshield burns
- [ ] Test full round-trip: shield → transfer → unshield

---

## 8. File Changes Required

### New Files
```
poc/
├── contracts/
│   ├── railgun/           # Copy or import from ../contract/contracts/
│   │   ├── logic/
│   │   ├── proxy/
│   │   └── ...
│   └── BridgeAdapter.sol  # New: handles unshield → CCTP
├── lib/
│   ├── railgun_engine.ts  # Engine initialization
│   ├── wallet.ts          # Wallet management
│   └── prover.ts          # Proof generation wrapper
└── scripts/
    └── deploy_railgun.ts  # Railgun deployment
```

### Modified Files
```
poc/
├── contracts/
│   └── HubCCTPReceiver.sol    # Call RailgunSmartWallet.shield()
├── relayer/
│   └── relay.ts               # Construct ShieldRequest structs
├── test/
│   ├── e2e_shield.ts          # Use real shield flow
│   ├── e2e_transfer.ts        # Generate real proofs
│   └── e2e_unshield.ts        # Use transact() with unshield
└── package.json               # Add engine/wallet dependencies
```

---

## 9. Data Structure Reference

### ShieldRequest (for shield)
```solidity
struct ShieldRequest {
  CommitmentPreimage preimage;
  ShieldCiphertext ciphertext;
}

struct CommitmentPreimage {
  bytes32 npk;       // Poseidon(Poseidon(spendingPubKey, nullifyingKey), random)
  TokenData token;   // { tokenType, tokenAddress, tokenSubID }
  uint120 value;     // Amount
}

struct ShieldCiphertext {
  bytes32[3] encryptedBundle;  // Encrypted note data
  bytes32 shieldKey;           // Public key for shared secret
}
```

### Transaction (for transact)
```solidity
struct Transaction {
  SnarkProof proof;
  bytes32 merkleRoot;
  bytes32[] nullifiers;
  bytes32[] commitments;
  BoundParams boundParams;
  CommitmentPreimage unshieldPreimage;  // Only if unshielding
}

struct BoundParams {
  uint16 treeNumber;
  uint72 minGasPrice;
  UnshieldType unshield;  // NONE, NORMAL, or REDIRECT
  uint64 chainID;
  address adaptContract;
  bytes32 adaptParams;
  CommitmentCiphertext[] commitmentCiphertext;
}

struct SnarkProof {
  G1Point a;
  G2Point b;
  G1Point c;
}
```

---

## 10. Testing Considerations

### Proof Generation Time
- Groth16 proofs take 5-30 seconds depending on circuit size
- Use smaller circuits (1x2, 2x3) for faster iteration
- Consider proof caching during development

### Merkle Tree Sync
- Engine maintains local Merkle tree state
- Must sync from contract events before proving
- Use `quickSync` for faster initial sync

### Gas Costs
- Verification: ~300k-500k gas depending on circuit
- Shield: ~150k gas (no proof, just commitment insertion)
- Consider gas optimization for production

---

## 11. Known Limitations

1. **No POI (Proof of Innocence)**: This POC skips POI requirements present in production Railgun
2. **Single Token**: Only USDC, no multi-token support
3. **No Relayer Fees**: Direct transactions only, no privacy-preserving fee payment
4. **Test Artifacts**: Using test circuit artifacts, not production ceremony outputs

---

## 12. Resources

- [Railgun Contract Repo](../contract/) - Smart contracts
- [Railgun Engine](../engine/) - Core cryptographic engine
- [Railgun Wallet SDK](../wallet/) - High-level wallet interface
- [Circuit Artifacts](railgun-circuit-test-artifacts) - Test verification keys
- [Circom Circuits](../circuits-v2/) - ZK circuit definitions

---

## Appendix A: Quick Reference Commands

```bash
# Install dependencies
npm install @railgun-community/engine @railgun-community/wallet snarkjs

# Deploy Railgun (from contract directory)
cd ../contract
npx hardhat deploy:no_governance --weth9 <WETH9> --network hub

# Run tests with real proofs
REAL_PROOFS=true npm run test:shield
REAL_PROOFS=true npm run test:transfer
REAL_PROOFS=true npm run test:unshield
```

## Appendix B: Circuit Input/Output Combinations

| Inputs (Nullifiers) | Outputs (Commitments) | Primary Use |
|---------------------|----------------------|-------------|
| 1 | 2 | Shield |
| 2 | 2 | Simple transfer |
| 2 | 3 | Transfer with change |
| 8 | 4 | Consolidate UTXOs |
| 12 | 2 | Large unshield |
| 1-14 | 1-14 | General (91 variants) |
