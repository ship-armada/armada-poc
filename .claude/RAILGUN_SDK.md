# Railgun SDK Integration Plan

This document outlines the step-by-step plan for replacing our manual cryptographic implementations with the official Railgun SDK (`@railgun-community/engine` and `@railgun-community/wallet`).

## Goals

1. Replace manual key derivation with SDK's BIP39/BIP32-based wallet creation
2. Replace simplified NPK generation with proper ECIES-encrypted note handling
3. Replace manual proof generation with SDK's prover
4. Add balance scanning via viewing keys
5. Maintain cross-chain CCTP bridge functionality

## Reference Repositories

The following repositories in this workspace serve as references:

| Repository | Path | Purpose |
|------------|------|---------|
| **engine** | `/Volumes/T7/railgun/engine` | Core wallet framework, key derivation, prover |
| **wallet** | `/Volumes/T7/railgun/wallet` | High-level SDK for shield/transfer/unshield |
| **circomlibjs** | `/Volumes/T7/railgun/circomlibjs` | Poseidon, EdDSA implementations |
| **circuits-v2** | `/Volumes/T7/railgun/circuits-v2` | Circom circuit definitions |
| **ppoi-safe-broadcaster-example** | `/Volumes/T7/railgun/ppoi-safe-broadcaster-example` | SDK usage patterns |

### Key Reference Files

**Engine initialization:**
- `engine/src/railgun-engine.ts` - `RailgunEngine.initForWallet()`
- `engine/src/wallet/railgun-wallet.ts` - `RailgunWallet.fromMnemonic()`

**Wallet SDK services:**
- `wallet/src/services/railgun/core/init.ts` - `startRailgunEngine()`
- `wallet/src/services/transactions/tx-shield.ts` - `generateShieldTransaction()`
- `wallet/src/services/transactions/tx-transfer.ts` - `populateProvedTransfer()`
- `wallet/src/services/transactions/tx-unshield.ts` - `populateProvedUnshield()`

**Key derivation:**
- `engine/src/key-derivation/bip39.ts` - Mnemonic generation/validation
- `engine/src/key-derivation/wallet-node.ts` - Key derivation paths

---

## Current POC vs SDK Comparison

| Component | Current POC | SDK Replacement |
|-----------|-------------|-----------------|
| **Key Derivation** | Random 32-byte spending key | BIP39 mnemonic → BIP32 derivation |
| **Spending Key Path** | N/A | `m/44'/1984'/0'/0'/{index}'` |
| **Viewing Key Path** | N/A (not implemented) | `m/420'/1984'/0'/0'/{index}'` |
| **NPK Generation** | `Poseidon(keccak(recipient), random)` | `Poseidon(masterPublicKey, random)` |
| **Note Encryption** | Plaintext in encryptedBundle | ECIES with viewing public key |
| **Proof Generation** | Direct snarkjs with test artifacts | SDK prover with artifact management |
| **Balance Scanning** | Manual note tracking | Automatic decryption via viewing keys |
| **Merkle Tree** | Client-side reconstruction | Engine-managed UTXOMerkletree |

---

## Implementation Steps

### Phase 1: Dependencies and Setup

#### Step 1.1: Install SDK packages

```bash
cd poc
npm install @railgun-community/engine @railgun-community/wallet @railgun-community/shared-models
npm install level leveldown  # For persistent storage
```

#### Step 1.2: Create SDK initialization module

Create `lib/sdk/init.ts`:

```typescript
/**
 * SDK Initialization
 *
 * Sets up RailgunEngine with:
 * - LevelDB storage for wallet data
 * - Artifact loading for proof generation
 * - Custom chain configuration for local devnet
 */

import { RailgunEngine } from '@railgun-community/engine';
import { AbstractLevelDOWN } from 'abstract-leveldown';
import leveldown from 'leveldown';
import path from 'path';

// Storage path for wallet database
const DB_PATH = path.join(__dirname, '../../data/railgun-db');

// Custom artifact getter for local devnet
// (Uses test artifacts from railgun-circuit-test-artifacts)
const artifactGetter = async (artifactName: string) => {
  // Implementation: Load from local artifacts or download
};

// Quick sync stub for local devnet (no historical data to sync)
const quickSyncEvents = async () => ({ commitmentEvents: [], unshieldEvents: [] });
const quickSyncRailgunTransactionsV2 = async () => [];

// Merkleroot validation stub (always valid for local devnet)
const validateMerkleroot = async () => true;
const getLatestValidatedTxid = async () => ({ txidIndex: undefined, merkleroot: undefined });

export async function initializeEngine(): Promise<RailgunEngine> {
  const engine = await RailgunEngine.initForWallet(
    'cctp-poc',           // walletSource (max 16 chars)
    leveldown(DB_PATH),   // LevelDB instance
    artifactGetter,
    quickSyncEvents,
    quickSyncRailgunTransactionsV2,
    validateMerkleroot,
    getLatestValidatedTxid,
    undefined,            // engineDebugger (optional)
    false                 // skipMerkletreeScans
  );

  return engine;
}
```

**Reference:** `engine/src/railgun-engine.ts:149-174`

#### Step 1.3: Configure local devnet chain

Create `lib/sdk/chain-config.ts`:

```typescript
/**
 * Chain configuration for local Anvil devnet
 */

import { Chain, ChainType } from '@railgun-community/engine';

export const HUB_CHAIN: Chain = {
  type: ChainType.EVM,
  id: 31338,  // Hub chain ID
};

export const CLIENT_CHAIN: Chain = {
  type: ChainType.EVM,
  id: 31337,  // Client chain ID
};

// Deployment block (0 for local devnet)
export const DEPLOYMENT_BLOCK = 0;

// RPC endpoints
export const HUB_RPC = 'http://localhost:8546';
export const CLIENT_RPC = 'http://localhost:8545';
```

---

### Phase 2: Replace Wallet Creation

#### Step 2.1: Create SDK wallet module

Create `lib/sdk/wallet.ts` to replace `lib/wallet.ts`:

```typescript
/**
 * SDK Wallet Management
 *
 * Replaces manual key derivation with SDK's proper:
 * - BIP39 mnemonic generation
 * - BIP32 key derivation (spending + viewing keys)
 * - EdDSA signing
 */

import { RailgunEngine, RailgunWallet, Mnemonic } from '@railgun-community/engine';

let engine: RailgunEngine;

export function setEngine(e: RailgunEngine) {
  engine = e;
}

export interface WalletInfo {
  id: string;
  mnemonic: string;
  railgunAddress: string;  // Bech32-encoded 0zk address
}

/**
 * Create a new wallet from mnemonic
 */
export async function createWallet(
  encryptionKey: string,
  mnemonic?: string,
  index: number = 0
): Promise<WalletInfo> {
  // Generate new mnemonic if not provided
  const walletMnemonic = mnemonic ?? Mnemonic.generate(128); // 12 words

  // Create wallet in engine
  const wallet = await engine.createWalletFromMnemonic(
    encryptionKey,
    walletMnemonic,
    index,
    undefined  // creationBlockNumbers (not needed for devnet)
  );

  // Get Railgun address (0zk...)
  const railgunAddress = wallet.getAddress();

  return {
    id: wallet.id,
    mnemonic: walletMnemonic,
    railgunAddress,
  };
}

/**
 * Load existing wallet
 */
export async function loadWallet(
  walletId: string,
  encryptionKey: string
): Promise<RailgunWallet> {
  return await engine.loadExistingWallet(walletId, encryptionKey) as RailgunWallet;
}

/**
 * Export wallet for storage
 */
export function exportWallet(info: WalletInfo): object {
  return {
    id: info.id,
    mnemonic: info.mnemonic,
    railgunAddress: info.railgunAddress,
    createdAt: new Date().toISOString(),
  };
}
```

**Reference:**
- `engine/src/railgun-engine.ts` - `createWalletFromMnemonic()`
- `engine/src/wallet/railgun-wallet.ts` - `RailgunWallet.fromMnemonic()`
- `engine/src/key-derivation/bip39.ts` - `Mnemonic.generate()`

#### Step 2.2: Update wallet storage format

Update `wallets/*.json` schema to include mnemonic:

```json
{
  "id": "wallet-id-hash",
  "mnemonic": "word1 word2 ... word12",
  "railgunAddress": "0zk1q...",
  "createdAt": "2024-01-12T..."
}
```

---

### Phase 3: Replace Shield Request Generation

#### Step 3.1: Create SDK shield module

Create `lib/sdk/shield.ts` to replace `lib/shield_request.ts`:

```typescript
/**
 * SDK Shield Operations
 *
 * Replaces manual NPK/ciphertext generation with SDK's:
 * - ShieldNoteERC20 with proper encryption
 * - masterPublicKey + viewingPublicKey derivation
 */

import {
  RailgunEngine,
  ShieldNoteERC20,
  ByteUtils,
  ShieldRequestStruct,
} from '@railgun-community/engine';
import { ethers } from 'ethers';

/**
 * Generate shield request for USDC
 *
 * @param railgunAddress - Recipient's 0zk address
 * @param amount - Amount in smallest units (6 decimals for USDC)
 * @param tokenAddress - USDC contract address
 * @param shieldPrivateKey - Key for encrypting shield data
 */
export async function createShieldRequest(
  railgunAddress: string,
  amount: bigint,
  tokenAddress: string,
  shieldPrivateKey: string
): Promise<{
  shieldRequest: ShieldRequestStruct;
  random: string;
}> {
  // Decode Railgun address to get public keys
  const { masterPublicKey, viewingPublicKey } =
    RailgunEngine.decodeAddress(railgunAddress);

  // Generate random for note
  const random = ByteUtils.randomHex(16);

  // Create shield note
  const shieldNote = new ShieldNoteERC20(
    masterPublicKey,
    random,
    amount,
    tokenAddress
  );

  // Serialize with encryption
  const shieldRequest = shieldNote.serialize(
    ByteUtils.hexToBytes(shieldPrivateKey),
    viewingPublicKey
  );

  return { shieldRequest, random };
}

/**
 * Get message to sign for shield private key derivation
 */
export function getShieldPrivateKeyMessage(): string {
  return ShieldNoteERC20.getShieldPrivateKeySignatureMessage();
}

/**
 * Derive shield private key from signature
 */
export function deriveShieldPrivateKey(signature: string): string {
  // First 32 bytes of signature hash
  return ethers.keccak256(signature).slice(0, 66);
}
```

**Reference:**
- `wallet/src/services/transactions/tx-shield.ts` - `generateERC20ShieldRequests()`
- `engine/src/note/shield-note-erc20.ts` - `ShieldNoteERC20`

#### Step 3.2: Update ClientShieldProxyV2 integration

Modify shield test to use SDK-generated requests:

```typescript
// In test/e2e_shield_v2.ts

import { createShieldRequest, deriveShieldPrivateKey, getShieldPrivateKeyMessage } from '../lib/sdk/shield';

// Get shield private key from user signature
const message = getShieldPrivateKeyMessage();
const signature = await user.signMessage(message);
const shieldPrivateKey = deriveShieldPrivateKey(signature);

// Generate shield request
const { shieldRequest } = await createShieldRequest(
  aliceWallet.railgunAddress,
  parseUSDC("100"),
  deployments.client.contracts.mockUSDC,
  shieldPrivateKey
);

// Call contract with SDK-generated data
await clientShieldProxyV2.shield(
  shieldRequest.preimage.value,
  shieldRequest.preimage.npk,
  shieldRequest.encryptedBundle,
  shieldRequest.shieldKey
);
```

---

### Phase 4: Replace Merkle Tree Management

#### Step 4.1: Use SDK's UTXOMerkletree

Create `lib/sdk/merkletree.ts` to replace `lib/merkle_tree.ts`:

```typescript
/**
 * SDK Merkle Tree Integration
 *
 * Uses engine's UTXOMerkletree instead of manual tree
 */

import { RailgunEngine, UTXOMerkletree, TXIDVersion } from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';

let engine: RailgunEngine;

export function setEngine(e: RailgunEngine) {
  engine = e;
}

/**
 * Get merkle tree for chain
 */
export function getMerkletree(chain: Chain): UTXOMerkletree {
  return engine.getUTXOMerkletree(TXIDVersion.V2_PoseidonMerkle, chain);
}

/**
 * Sync merkle tree from contract events
 */
export async function syncMerkletree(chain: Chain): Promise<void> {
  await engine.scanContractHistory(chain);
}

/**
 * Get current merkle root
 */
export function getMerkleRoot(chain: Chain): bigint {
  const tree = getMerkletree(chain);
  return tree.merkleRoot;
}

/**
 * Get proof for commitment
 */
export function getMerkleProof(chain: Chain, leafIndex: number): {
  root: bigint;
  pathElements: bigint[];
  pathIndices: number[];
} {
  const tree = getMerkletree(chain);
  return tree.getProof(leafIndex);
}
```

**Reference:**
- `engine/src/merkletree/utxo-merkletree.ts`
- `engine/src/railgun-engine.ts` - `getUTXOMerkletree()`

---

### Phase 5: Replace Proof Generation

#### Step 5.1: Create SDK prover module

Create `lib/sdk/prover.ts` to replace `lib/prover.ts`:

```typescript
/**
 * SDK Proof Generation
 *
 * Uses engine's Prover with proper artifact management
 */

import {
  RailgunEngine,
  TransactionBatch,
  TransactionStruct,
  TXIDVersion,
} from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';

let engine: RailgunEngine;

export function setEngine(e: RailgunEngine) {
  engine = e;
}

/**
 * Generate proof for private transfer
 */
export async function generateTransferProof(
  chain: Chain,
  walletId: string,
  encryptionKey: string,
  erc20AmountRecipients: Array<{
    recipientAddress: string;
    tokenAddress: string;
    amount: bigint;
  }>,
): Promise<TransactionStruct> {
  const wallet = await engine.loadExistingWallet(walletId, encryptionKey);

  // Build transaction batch
  const batch = new TransactionBatch(chain);

  for (const recipient of erc20AmountRecipients) {
    batch.addOutput({
      recipientAddress: recipient.recipientAddress,
      tokenAddress: recipient.tokenAddress,
      amount: recipient.amount,
    });
  }

  // Generate proof
  const { transaction } = await batch.generateTransaction(
    engine.prover,
    wallet,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    () => {} // progressCallback
  );

  return transaction;
}

/**
 * Generate proof for unshield
 */
export async function generateUnshieldProof(
  chain: Chain,
  walletId: string,
  encryptionKey: string,
  recipientAddress: string,  // EOA address (not Railgun)
  tokenAddress: string,
  amount: bigint,
): Promise<TransactionStruct> {
  const wallet = await engine.loadExistingWallet(walletId, encryptionKey);

  const batch = new TransactionBatch(chain);

  batch.addUnshieldOutput({
    recipientAddress,
    tokenAddress,
    amount,
    unshieldType: 1, // NORMAL
  });

  const { transaction } = await batch.generateTransaction(
    engine.prover,
    wallet,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    () => {}
  );

  return transaction;
}
```

**Reference:**
- `engine/src/prover/prover.ts`
- `engine/src/transaction/transaction-batch.ts`
- `wallet/src/services/transactions/tx-transfer.ts`

---

### Phase 6: Replace Transfer Module

#### Step 6.1: Create SDK transfer module

Create `lib/sdk/transfer.ts` to replace `lib/transfer.ts`:

```typescript
/**
 * SDK Transfer Operations
 *
 * High-level API for private transfers and unshields
 */

import { ethers } from 'ethers';
import { RailgunEngine, TXIDVersion } from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';
import { generateTransferProof, generateUnshieldProof } from './prover';

let engine: RailgunEngine;

export function setEngine(e: RailgunEngine) {
  engine = e;
}

export interface TransferRequest {
  senderWalletId: string;
  encryptionKey: string;
  recipientRailgunAddress: string;
  tokenAddress: string;
  amount: bigint;
  chain: Chain;
}

export interface UnshieldRequest {
  senderWalletId: string;
  encryptionKey: string;
  recipientAddress: string;  // EOA
  tokenAddress: string;
  amount: bigint;
  chain: Chain;
  adaptContract?: string;  // For cross-chain via HubUnshieldProxy
}

/**
 * Execute private transfer
 */
export async function executeTransfer(
  request: TransferRequest,
  signer: ethers.Signer,
  railgunAddress: string
): Promise<ethers.TransactionReceipt | null> {
  // Generate proof
  const transaction = await generateTransferProof(
    request.chain,
    request.senderWalletId,
    request.encryptionKey,
    [{
      recipientAddress: request.recipientRailgunAddress,
      tokenAddress: request.tokenAddress,
      amount: request.amount,
    }]
  );

  // Submit to contract
  const contract = new ethers.Contract(
    railgunAddress,
    ['function transact(tuple[] transactions) external'],
    signer
  );

  const tx = await contract.transact([transaction]);
  return tx.wait();
}

/**
 * Execute unshield (withdraw from shielded pool)
 */
export async function executeUnshield(
  request: UnshieldRequest,
  signer: ethers.Signer,
  railgunAddress: string
): Promise<ethers.TransactionReceipt | null> {
  const transaction = await generateUnshieldProof(
    request.chain,
    request.senderWalletId,
    request.encryptionKey,
    request.recipientAddress,
    request.tokenAddress,
    request.amount
  );

  const contract = new ethers.Contract(
    railgunAddress,
    ['function transact(tuple[] transactions) external'],
    signer
  );

  const tx = await contract.transact([transaction]);
  return tx.wait();
}
```

**Reference:**
- `wallet/src/services/transactions/tx-transfer.ts`
- `wallet/src/services/transactions/tx-unshield.ts`

---

### Phase 7: Add Balance Scanning

#### Step 7.1: Create balance module

Create `lib/sdk/balance.ts`:

```typescript
/**
 * SDK Balance Management
 *
 * Scan and decrypt balances using viewing keys
 */

import { RailgunEngine, TXIDVersion, RailgunWallet } from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';

let engine: RailgunEngine;

export function setEngine(e: RailgunEngine) {
  engine = e;
}

export interface TokenBalance {
  tokenAddress: string;
  balance: bigint;
  utxoCount: number;
}

/**
 * Scan for wallet balances
 */
export async function scanBalances(
  walletId: string,
  chain: Chain
): Promise<void> {
  // Trigger merkletree scan which decrypts balances
  await engine.scanContractHistory(chain, [walletId]);
}

/**
 * Get current balances for wallet
 */
export async function getBalances(
  walletId: string,
  encryptionKey: string,
  chain: Chain
): Promise<TokenBalance[]> {
  const wallet = await engine.loadExistingWallet(walletId, encryptionKey) as RailgunWallet;

  const balancesByTree = await wallet.getBalancesByTreeNumber(
    TXIDVersion.V2_PoseidonMerkle,
    chain
  );

  // Aggregate balances across trees
  const balances: Map<string, TokenBalance> = new Map();

  for (const [, tokenBalances] of Object.entries(balancesByTree)) {
    for (const [tokenAddress, balance] of Object.entries(tokenBalances)) {
      const existing = balances.get(tokenAddress) ?? {
        tokenAddress,
        balance: 0n,
        utxoCount: 0,
      };
      existing.balance += BigInt(balance.balance);
      existing.utxoCount += balance.utxos.length;
      balances.set(tokenAddress, existing);
    }
  }

  return Array.from(balances.values());
}

/**
 * Get spendable notes for a token
 */
export async function getSpendableNotes(
  walletId: string,
  encryptionKey: string,
  chain: Chain,
  tokenAddress: string
): Promise<Array<{
  commitment: string;
  value: bigint;
  treeNumber: number;
  position: number;
}>> {
  const wallet = await engine.loadExistingWallet(walletId, encryptionKey) as RailgunWallet;

  const commitments = await wallet.getReceiveCommitments(
    TXIDVersion.V2_PoseidonMerkle,
    chain
  );

  return commitments
    .filter(c => c.tokenHash === tokenAddress.toLowerCase())
    .map(c => ({
      commitment: c.commitment,
      value: BigInt(c.value),
      treeNumber: c.treeNumber,
      position: c.position,
    }));
}
```

**Reference:**
- `engine/src/wallet/abstract-wallet.ts` - `getBalancesByTreeNumber()`
- `wallet/src/services/railgun/wallets/balance-update.ts`

---

### Phase 8: Update Tests

#### Step 8.1: Update e2e_shield_v2.ts

```typescript
// Key changes:
// 1. Initialize SDK engine at start
// 2. Create wallet from mnemonic (not random key)
// 3. Use SDK shield request generation
// 4. Scan balances after shield completes

import { initializeEngine } from '../lib/sdk/init';
import { createWallet, exportWallet } from '../lib/sdk/wallet';
import { createShieldRequest, deriveShieldPrivateKey } from '../lib/sdk/shield';
import { scanBalances, getBalances } from '../lib/sdk/balance';

async function main() {
  // Initialize SDK
  const engine = await initializeEngine();

  // Create or load wallet
  const encryptionKey = 'test-encryption-key';
  const aliceWallet = await createWallet(encryptionKey);

  // Save wallet info
  fs.writeFileSync(
    'wallets/alice.json',
    JSON.stringify(exportWallet(aliceWallet), null, 2)
  );

  // Generate shield request using SDK
  const { shieldRequest } = await createShieldRequest(
    aliceWallet.railgunAddress,
    parseUSDC("100"),
    deployments.client.contracts.mockUSDC,
    shieldPrivateKey
  );

  // ... submit transaction ...

  // Scan balances after shield completes
  await scanBalances(aliceWallet.id, HUB_CHAIN);
  const balances = await getBalances(aliceWallet.id, encryptionKey, HUB_CHAIN);
  console.log('Shielded balances:', balances);
}
```

#### Step 8.2: Update e2e_transfer_v2.ts

```typescript
// Key changes:
// 1. Load wallet from storage (with mnemonic)
// 2. Use SDK transfer proof generation
// 3. Scan balances for both sender and recipient

import { initializeEngine } from '../lib/sdk/init';
import { loadWallet } from '../lib/sdk/wallet';
import { executeTransfer } from '../lib/sdk/transfer';
import { scanBalances, getBalances } from '../lib/sdk/balance';

async function main() {
  const engine = await initializeEngine();

  // Load sender wallet
  const aliceData = JSON.parse(fs.readFileSync('wallets/alice.json', 'utf-8'));
  const aliceWallet = await loadWallet(aliceData.id, encryptionKey);

  // Load or create recipient wallet
  const bobWallet = await createWallet(encryptionKey);

  // Execute transfer using SDK
  await executeTransfer({
    senderWalletId: aliceData.id,
    encryptionKey,
    recipientRailgunAddress: bobWallet.railgunAddress,
    tokenAddress: deployments.hub.contracts.mockUSDC,
    amount: parseUSDC("50"),
    chain: HUB_CHAIN,
  }, signer, railgunAddress);

  // Verify balances
  await scanBalances(aliceData.id, HUB_CHAIN);
  await scanBalances(bobWallet.id, HUB_CHAIN);
}
```

#### Step 8.3: Update e2e_crosschain_unshield.ts

```typescript
// Key changes:
// 1. Use SDK unshield proof generation
// 2. Support REDIRECT unshield for cross-chain via HubUnshieldProxy

import { executeUnshield } from '../lib/sdk/transfer';

// For cross-chain unshield, use REDIRECT to HubUnshieldProxy
await executeUnshield({
  senderWalletId: aliceData.id,
  encryptionKey,
  recipientAddress: hubUnshieldProxyAddress,  // Redirects here first
  tokenAddress: deployments.hub.contracts.mockUSDC,
  amount: parseUSDC("25"),
  chain: HUB_CHAIN,
  adaptContract: hubUnshieldProxyAddress,
}, signer, railgunAddress);
```

---

### Phase 9: Integration Testing

#### Step 9.1: Verify all flows work

1. **Shield flow:**
   - SDK wallet creation with mnemonic
   - SDK shield request generation
   - CCTP bridge → hub
   - Balance scanning shows shielded amount

2. **Transfer flow:**
   - SDK proof generation
   - Private transfer between wallets
   - Both sender/recipient balances update

3. **Unshield flow:**
   - SDK unshield proof generation
   - REDIRECT to HubUnshieldProxy
   - CCTP bridge → client
   - Recipient receives USDC

#### Step 9.2: Update npm scripts

```json
{
  "scripts": {
    "test:shield": "npx ts-node test/e2e_shield_v2.ts",
    "test:transfer": "npx ts-node test/e2e_transfer_v2.ts",
    "test:unshield": "npx ts-node test/e2e_crosschain_unshield.ts",
    "test:all": "npm run test:shield && npm run test:transfer && npm run test:unshield"
  }
}
```

---

## File Changes Summary

### Files to Create

| File | Purpose |
|------|---------|
| `lib/sdk/init.ts` | Engine initialization |
| `lib/sdk/chain-config.ts` | Chain configuration |
| `lib/sdk/wallet.ts` | Wallet management |
| `lib/sdk/shield.ts` | Shield operations |
| `lib/sdk/merkletree.ts` | Merkle tree integration |
| `lib/sdk/prover.ts` | Proof generation |
| `lib/sdk/transfer.ts` | Transfer/unshield operations |
| `lib/sdk/balance.ts` | Balance scanning |
| `data/.gitkeep` | Database storage directory |

### Files to Replace (Move to _legacy/)

| Current File | SDK Replacement |
|--------------|-----------------|
| `lib/wallet.ts` | `lib/sdk/wallet.ts` |
| `lib/shield_request.ts` | `lib/sdk/shield.ts` |
| `lib/merkle_tree.ts` | `lib/sdk/merkletree.ts` |
| `lib/prover.ts` | `lib/sdk/prover.ts` |
| `lib/transfer.ts` | `lib/sdk/transfer.ts` |

### Files to Update

| File | Changes |
|------|---------|
| `test/e2e_shield_v2.ts` | Use SDK modules |
| `test/e2e_transfer_v2.ts` | Use SDK modules |
| `test/e2e_crosschain_unshield.ts` | Use SDK modules |
| `package.json` | Add SDK dependencies |
| `wallets/*.json` | Include mnemonic in schema |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| SDK expects mainnet/testnet config | Create custom chain config for local devnet |
| Artifact downloading may fail offline | Pre-load artifacts in `artifacts/` directory |
| POI (Proof of Innocence) validation | Stub out for local devnet testing |
| Quick sync expects graph endpoints | Provide stub implementations |

---

## Success Criteria

1. All three flows (shield, transfer, unshield) pass with SDK integration
2. Wallet creation uses BIP39 mnemonic
3. Shield requests use proper ECIES encryption
4. Balance scanning works via viewing keys
5. Proof generation uses SDK prover
6. No manual Poseidon/EdDSA code remains (moved to _legacy/)

---

## Implementation Status

### Completed Phases

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Dependencies and Setup | COMPLETE | SDK packages installed, engine initialization works |
| Phase 2: Replace Wallet Creation | COMPLETE | `lib/sdk/wallet.ts` with BIP39 mnemonic support |
| Phase 3: Replace Shield Request Generation | COMPLETE | `lib/sdk/shield.ts` with proper NPK/ciphertext |
| Phase 4: Replace Merkle Tree Management | COMPLETE | `lib/sdk/network.ts` with engine merkle tree |
| Phase 5: Replace Proof Generation | COMPLETE | `lib/sdk/prover.ts` with snarkjs integration |
| Phase 6: Replace Transfer Module | COMPLETE | `lib/sdk/transfer.ts` with balance checking |
| Phase 7: Add Balance Scanning | COMPLETE | Integrated into network.ts and transfer.ts |
| Phase 8: Update Tests | COMPLETE | New SDK e2e tests created |
| Phase 9: Integration Testing | PARTIAL | Requires running devnet |

### SDK Module Files Created

| File | Description |
|------|-------------|
| `lib/sdk/index.ts` | Central export point for all SDK modules |
| `lib/sdk/init.ts` | Engine initialization with LevelDB |
| `lib/sdk/chain-config.ts` | Chain configuration for devnet |
| `lib/sdk/wallet.ts` | Wallet creation/loading with BIP39 |
| `lib/sdk/shield.ts` | Shield request generation |
| `lib/sdk/network.ts` | Network loading and merkle tree sync |
| `lib/sdk/prover.ts` | Proof generation with snarkjs |
| `lib/sdk/transfer.ts` | High-level transfer/unshield API |

### Test Files Created

| File | Description |
|------|-------------|
| `test/e2e_shield_sdk.ts` | Shield flow using SDK modules |
| `test/e2e_transfer_sdk.ts` | Transfer flow using SDK modules |
| `test/e2e_unshield_sdk.ts` | Unshield flow using SDK modules |
| `lib/sdk/test-*.ts` | Unit tests for individual SDK modules |

### Legacy Files Moved

The following files have been moved to `lib/_legacy/`:
- `wallet.ts` → Uses manual key derivation
- `shield_request.ts` → Uses simplified NPK generation
- `merkle_tree.ts` → Uses client-side merkle tree
- `prover.ts` → Uses direct snarkjs without SDK
- `transfer.ts` → Uses manual UTXO management

### NPM Scripts Added

```bash
# SDK e2e tests
npm run test:sdk:shield    # Shield flow with SDK
npm run test:sdk:transfer  # Transfer flow with SDK
npm run test:sdk:unshield  # Unshield flow with SDK
npm run test:sdk:all       # All SDK e2e tests

# SDK module unit tests
npm run test:sdk:modules   # Test all SDK modules
```

### Next Steps

1. **Integration Testing**: Run full e2e tests on deployed devnet
2. **Balance Verification**: Test balance scanning after shield/transfer
3. **Cross-Chain Flow**: Verify CCTP bridge integration with SDK
