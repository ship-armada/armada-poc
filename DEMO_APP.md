# Demo App Implementation Plan

## Overview

A USDC-focused private payments demo app built with Vite + React. The app demonstrates shielding, private transfers, and unshielding across multiple chains using the Railgun POC infrastructure.

## Tech Stack

- **Framework**: Vite + React + TypeScript
- **Wallet**: wagmi + viem (MetaMask integration)
- **Styling**: Tailwind CSS (fast iteration)
- **State**: React Context + zustand (lightweight)
- **Build**: Vite (fast HMR, easy Netlify deploy)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Browser                                        │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  Demo App (Vite + React)                                           │ │
│  │                                                                    │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │ │
│  │  │   MetaMask   │  │   Shielded   │  │      SDK Integration     │ │ │
│  │  │  Connection  │  │   Wallet     │  │  (proof gen, scanning)   │ │ │
│  │  │  (wagmi)     │  │  (derived)   │  │                          │ │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘ │ │
│  │                                                                    │ │
│  │  ┌────────────────────────────────────────────────────────────┐   │ │
│  │  │                        UI Sections                          │   │ │
│  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐│   │ │
│  │  │  │ Balance │  │ Deposit │  │   Pay   │  │     Faucet      ││   │ │
│  │  │  │ Display │  │  Form   │  │  Form   │  │    (devnet)     ││   │ │
│  │  │  └─────────┘  └─────────┘  └─────────┘  └─────────────────┘│   │ │
│  │  └────────────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
          │                    │                      │
          ▼                    ▼                      ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐
│   Client A      │  │   Client B      │  │         Hub Chain           │
│   (31337)       │  │   (31339)       │  │         (31338)             │
│   :8545         │  │   :8547         │  │         :8546               │
│                 │  │                 │  │                             │
│ - MockUSDC      │  │ - MockUSDC      │  │ - MockUSDC                  │
│ - ShieldProxy   │  │ - ShieldProxy   │  │ - RailgunSmartWallet        │
│ - Faucet        │  │ - Faucet        │  │ - HubCCTPReceiver           │
└─────────────────┘  └─────────────────┘  └─────────────────────────────┘
```

## Chain Configuration

Chains are configured via a JSON file for easy modification:

```typescript
// src/config/chains.json
{
  "chains": [
    {
      "id": 31338,
      "name": "Hub Chain",
      "type": "hub",
      "rpcUrl": "http://localhost:8546",
      "nativeCurrency": {
        "name": "Ether",
        "symbol": "ETH",
        "decimals": 18
      },
      "contracts": {
        "mockUSDC": "0x...",           // Loaded from deployments
        "railgunProxy": "0x...",
        "hubCCTPReceiver": "0x...",
        "hubUnshieldProxy": "0x..."
      }
    },
    {
      "id": 31337,
      "name": "Client A",
      "type": "client",
      "rpcUrl": "http://localhost:8545",
      "nativeCurrency": {
        "name": "Ether",
        "symbol": "ETH",
        "decimals": 18
      },
      "contracts": {
        "mockUSDC": "0x...",
        "clientShieldProxy": "0x...",
        "faucet": "0x..."              // New contract
      }
    },
    {
      "id": 31339,
      "name": "Client B",
      "type": "client",
      "rpcUrl": "http://localhost:8547",
      "nativeCurrency": {
        "name": "Ether",
        "symbol": "ETH",
        "decimals": 18
      },
      "contracts": {
        "mockUSDC": "0x...",
        "clientShieldProxy": "0x...",
        "faucet": "0x..."
      }
    }
  ],
  "tokens": {
    "USDC": {
      "symbol": "USDC",
      "decimals": 6,
      "logoUrl": "/usdc.svg"
    }
  }
}
```

## Folder Structure

```
poc/
└── demo-app/
    ├── public/
    │   └── usdc.svg
    ├── src/
    │   ├── main.tsx                    # Entry point
    │   ├── App.tsx                     # Main app layout
    │   │
    │   ├── config/
    │   │   ├── chains.json             # Chain configuration
    │   │   └── index.ts                # Config loader
    │   │
    │   ├── lib/
    │   │   ├── keyDerivation.ts        # MetaMask sig → keys
    │   │   ├── keyManager.ts           # Closure-based key storage
    │   │   ├── sdk.ts                  # SDK wrapper (imports from ../lib/sdk)
    │   │   └── contracts.ts            # Contract ABIs and helpers
    │   │
    │   ├── hooks/
    │   │   ├── useShieldedWallet.ts    # Shielded wallet context
    │   │   ├── useChainConfig.ts       # Chain config access
    │   │   ├── useBalance.ts           # Public + shielded balances
    │   │   └── useTransactions.ts      # Transaction history/status
    │   │
    │   ├── components/
    │   │   ├── layout/
    │   │   │   ├── Header.tsx          # Nav + wallet status
    │   │   │   └── ChainSelector.tsx   # Network switcher
    │   │   │
    │   │   ├── wallet/
    │   │   │   ├── ConnectButton.tsx   # MetaMask connect
    │   │   │   ├── UnlockPrompt.tsx    # Sign to derive keys
    │   │   │   └── WalletStatus.tsx    # EOA + shielded addresses
    │   │   │
    │   │   ├── balance/
    │   │   │   ├── BalanceCard.tsx     # Shielded USDC balance
    │   │   │   └── PublicBalance.tsx   # Public USDC per chain
    │   │   │
    │   │   ├── deposit/
    │   │   │   ├── DepositForm.tsx     # Shield form
    │   │   │   └── ChainSelect.tsx     # Source chain picker
    │   │   │
    │   │   ├── pay/
    │   │   │   ├── PayForm.tsx         # Main pay form
    │   │   │   ├── RecipientInput.tsx  # Address input (0zk or 0x)
    │   │   │   └── DestinationSelect.tsx # Chain picker (for 0x)
    │   │   │
    │   │   ├── faucet/
    │   │   │   └── FaucetButton.tsx    # Request test tokens
    │   │   │
    │   │   └── transactions/
    │   │       ├── TxStatus.tsx        # Pending tx indicator
    │   │       └── TxHistory.tsx       # Recent transactions
    │   │
    │   └── styles/
    │       └── globals.css             # Tailwind imports
    │
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── tsconfig.json
```

## Core Flows

### 1. Wallet Connection & Key Derivation

```
User clicks "Connect Wallet"
         │
         ▼
wagmi connects to MetaMask
         │
         ▼
User clicks "Unlock Shielded Wallet"
         │
         ▼
App prompts for signature (per WEB_KEY_DERIVATION.md)
         │
         ▼
Derive spending + viewing keys from signature
         │
         ▼
Create Railgun wallet in SDK with derived keys
         │
         ▼
Display shielded address (0zk...)
```

### 2. Shielded Balance Display

```
On unlock / periodic refresh:
         │
         ▼
SDK scans merkle tree for notes belonging to viewing key
         │
         ▼
Sum USDC commitments → shielded balance
         │
         ▼
Display: "Shielded Balance: 100.00 USDC"
```

### 3. Deposit (Shield) Flow

```
User selects source chain (Client A, Client B, or Hub)
         │
         ▼
User enters amount (e.g., 50 USDC)
         │
         ▼
App checks public USDC balance on source chain
         │
         ▼
User clicks "Deposit"
         │
         ▼
If source is Hub:
  └─► Direct shield via RailgunSmartWallet.shield()
         │
If source is Client chain:
  └─► 1. Approve ClientShieldProxy for USDC
      2. Call ClientShieldProxy.shield()
      3. Relayer picks up BurnForDeposit event
      4. Relayer mints + calls HubCCTPReceiver
      5. Hub adds commitment to merkle tree
         │
         ▼
Poll for Shield event on hub
         │
         ▼
Refresh shielded balance
         │
         ▼
Show success: "Deposited 50 USDC"
```

### 4. Pay Flow (Transfer or Unshield)

```
User enters recipient address
         │
         ├─► If 0zk... (shielded address):
         │       │
         │       ▼
         │   Private transfer within shielded pool
         │       │
         │       ▼
         │   1. generateTransferProof() [~30 seconds, show progress]
         │   2. populateProvedTransfer()
         │   3. Submit tx to RailgunSmartWallet.transact()
         │       │
         │       ▼
         │   Show success: "Sent 25 USDC privately"
         │
         └─► If 0x... (public address):
                 │
                 ▼
             User selects destination chain
                 │
                 ▼
             1. generateUnshieldProof() [~30 seconds, show progress]
             2. populateProvedUnshield()
             3. Submit tx to RailgunSmartWallet.transact()
                 │
                 ▼
             User receives USDC on Hub chain
                 │
                 ├─► If destination is Hub:
                 │       Done - funds already on Hub
                 │
                 └─► If destination is Client chain:
                         │
                         ▼
                     4. Approve HubUnshieldProxy for USDC
                     5. Call HubUnshieldProxy.bridgeTo(amount, recipient, chainId)
                     6. Relayer picks up BurnForDeposit event
                     7. Relayer mints on client chain
                         │
                         ▼
                     Show success: "Sent 25 USDC to 0x... on Client A"
```

**Note:** Cross-chain unshield is a 2-step process:
1. Unshield from Railgun to user's Hub address (requires zk proof)
2. Bridge from Hub to Client chain (uses CCTP simulation via relayer)

### 5. Faucet Flow

```
User clicks "Get Test Tokens" for a chain
         │
         ▼
Call Faucet contract on that chain
         │
         ▼
Faucet mints:
  - 1000 USDC (mock)
  - 1 ETH (native, for gas)
         │
         ▼
Refresh public balances
         │
         ▼
Show success: "Received 1000 USDC + 1 ETH on Client A"
```

## Faucet Contract

A simple faucet contract deployed on each chain:

```solidity
// contracts/Faucet.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./MockUSDC.sol";

contract Faucet {
    MockUSDC public immutable usdc;
    uint256 public constant USDC_AMOUNT = 1000 * 1e6;  // 1000 USDC
    uint256 public constant ETH_AMOUNT = 1 ether;

    mapping(address => uint256) public lastFaucetTime;
    uint256 public constant COOLDOWN = 0;  // No cooldown for local devnet

    constructor(address _usdc) payable {
        usdc = MockUSDC(_usdc);
    }

    function drip() external {
        require(
            block.timestamp >= lastFaucetTime[msg.sender] + COOLDOWN,
            "Cooldown not elapsed"
        );

        lastFaucetTime[msg.sender] = block.timestamp;

        // Mint USDC
        usdc.mint(msg.sender, USDC_AMOUNT);

        // Send ETH if contract has balance
        if (address(this).balance >= ETH_AMOUNT) {
            payable(msg.sender).transfer(ETH_AMOUNT);
        }
    }

    // Allow funding the faucet with ETH
    receive() external payable {}
}
```

## Devnet Updates Required

### 1. Deploy Faucet Contract

Add to deployment scripts:

```typescript
// scripts/deploy_faucet.ts
async function deployFaucet(chain: "client" | "clientB" | "hub") {
  const deployment = loadDeployment(chain);

  const Faucet = await ethers.getContractFactory("Faucet");
  const faucet = await Faucet.deploy(deployment.contracts.mockUSDC, {
    value: ethers.parseEther("100")  // Fund with 100 ETH
  });

  // Update deployment file
  deployment.contracts.faucet = await faucet.getAddress();
  saveDeployment(chain, deployment);
}
```

### 2. Update npm scripts

```json
{
  "scripts": {
    "deploy:faucets": "npx hardhat run scripts/deploy_faucet.ts",
    "setup": "npm run compile && npm run deploy:hub && npm run deploy:client && npm run deploy:clientB && npm run deploy:railgun && npm run deploy:v2 && npm run deploy:faucets && npm run link"
  }
}
```

### 3. Fund Anvil Accounts

The default Anvil accounts already have 10,000 ETH each, so no changes needed for native token funding on local devnet.

## SDK Integration

The demo app uses the `@railgun-community/wallet` SDK for all Railgun operations. This section documents the required initialization steps and transaction flows based on the official Railgun documentation.

**Reference Documentation:**
- [Artifact Store](https://docs.railgun.org/developer-guide/wallet/getting-started/4.-build-a-persistent-store-for-artifact-downloads)
- [Engine Initialization](https://docs.railgun.org/developer-guide/wallet/getting-started/5.-start-the-railgun-privacy-engine)
- [Prover Setup](https://docs.railgun.org/developer-guide/wallet/getting-started/6.-load-a-groth16-prover-for-each-platform)
- [Unshield Flow](https://docs.railgun.org/developer-guide/wallet/transactions/unshielding/unshield-erc-20-tokens)

### 1. Artifact Store (Browser)

ZK circuit artifacts (~50MB) are downloaded on-demand and cached in IndexedDB:

```typescript
// lib/railgun/artifacts.ts
import { ArtifactStore } from '@railgun-community/wallet';

export function createBrowserArtifactStore(): ArtifactStore {
  // Uses IndexedDB for persistent storage
  return new ArtifactStore(getArtifact, storeArtifact, artifactExists);
}
```

**Status:** ✅ Implemented in `src/lib/railgun/artifacts.ts`

### 2. Database (Browser)

Uses level-js (IndexedDB-backed) for wallet storage:

```typescript
// lib/railgun/database.ts
import LevelDB from 'level-js';

export const createWebDatabase = (dbLocationPath: string) => {
  return new LevelDB(dbLocationPath);
};
```

**Status:** ✅ Implemented in `src/lib/railgun/database.ts`

### 3. Engine Initialization

Start the Railgun engine with browser-compatible settings:

```typescript
// lib/railgun/init.ts
import { startRailgunEngine } from '@railgun-community/wallet';

await startRailgunEngine(
  'railgunpoc',       // walletSource (max 16 chars)
  db,                 // LevelDB database
  true,               // shouldDebug
  artifactStore,      // ArtifactStore instance
  false,              // useNativeArtifacts (false for browser/WASM)
  false,              // skipMerkletreeScans (false to enable balance scanning)
  [],                 // poiNodeURLs (empty for local devnet)
  [],                 // customPOILists
  true                // verboseScanLogging
);
```

**Key Parameters:**
- `useNativeArtifacts: false` - Use WASM for browser (true only for mobile native)
- `skipMerkletreeScans: false` - Enable balance scanning
- `poiNodeURLs: []` - Empty for local devnet (no POI verification needed)

**Status:** ✅ Implemented in `src/lib/railgun/init.ts`

### 4. Prover Initialization (REQUIRED for Transfers/Unshields)

**IMPORTANT:** The Groth16 prover must be initialized before generating any proofs. This is NOT done automatically by the engine.

```typescript
// lib/railgun/prover.ts
import { getProver } from '@railgun-community/wallet';
import { groth16 } from 'snarkjs';

export async function initializeProver(): Promise<void> {
  // Set snarkjs as the Groth16 implementation for browser
  getProver().setSnarkJSGroth16(groth16 as any);
}
```

**When to call:** After engine initialization, before any transfer or unshield operations.

**Status:** ❌ NOT YET IMPLEMENTED - Required for Phase 6

### 5. Key Derivation → SDK Wallet

The challenge is bridging the MetaMask-derived keys with the SDK's BIP39-based wallet system. Two approaches:

**Option A: Use derived keys directly (recommended for POC)**

Modify the SDK to accept raw keys instead of mnemonic:

```typescript
// lib/sdk/wallet.ts - add new function
export async function createWalletFromKeys(
  encryptionKey: string,
  spendingKey: Uint8Array,
  viewingKey: Uint8Array
): Promise<WalletInfo> {
  // Create wallet with derived keys instead of mnemonic
  // This requires SDK modifications
}
```

**Option B: Derive deterministic mnemonic from signature (current approach)**

```typescript
// Derive a deterministic 12-word mnemonic from the signature
function signatureToMnemonic(signature: string): string {
  const entropy = keccak256(signature).slice(0, 16); // 128 bits = 12 words
  return entropyToMnemonic(entropy);
}
```

Option B is simpler and works with existing SDK without modifications.

**Status:** ✅ Implemented using Option B

### 6. Balance Scanning

```typescript
// hooks/useBalance.ts
function useShieldedBalance() {
  const [balance, setBalance] = useState<bigint>(0n);
  const { walletId } = useShieldedWallet();

  useEffect(() => {
    if (!walletId) return;

    const scan = async () => {
      // Scan merkle tree
      await scanMerkletree(HUB_CHAIN);

      // Get wallet balances
      const balances = await getWalletBalances(walletId);

      // Find USDC balance
      const usdcBalance = balances.find(b =>
        b.tokenAddress === USDC_ADDRESS
      );

      setBalance(usdcBalance?.balance ?? 0n);
    };

    scan();
    const interval = setInterval(scan, 10000); // Poll every 10s

    return () => clearInterval(interval);
  }, [walletId]);

  return balance;
}
```

**Status:** ✅ Implemented

### 7. Transaction Flows (Using SDK Functions)

The SDK provides high-level functions for transactions. **Do NOT manually build proofs** - use these SDK functions instead:

#### Private Transfer (0zk → 0zk)

```typescript
import {
  generateTransferProof,
  populateProvedTransfer,
  gasEstimateForUnprovenTransfer,
} from '@railgun-community/wallet';
import { TXIDVersion, NetworkName } from '@railgun-community/shared-models';

// Step 1: Estimate gas
const gasEstimate = await gasEstimateForUnprovenTransfer(
  TXIDVersion.V2_PoseidonMerkle,
  networkName,
  railgunWalletID,
  encryptionKey,
  false,                    // showSenderAddressToRecipient
  undefined,                // memoText
  erc20AmountRecipients,    // [{ tokenAddress, amount, recipientAddress }]
  [],                       // nftAmountRecipients
  undefined,                // broadcasterFeeERC20AmountRecipient
  true,                     // sendWithPublicWallet
  originalGasDetails,
  undefined                 // feeTokenDetails
);

// Step 2: Generate proof (20-30 seconds in browser)
await generateTransferProof(
  TXIDVersion.V2_PoseidonMerkle,
  networkName,
  railgunWalletID,
  encryptionKey,
  false,                    // showSenderAddressToRecipient
  undefined,                // memoText
  erc20AmountRecipients,
  [],                       // nftAmountRecipients
  undefined,                // broadcasterFeeERC20AmountRecipient
  true,                     // sendWithPublicWallet
  undefined,                // overallBatchMinGasPrice
  (progress) => console.log(`Proof: ${progress}%`)
);

// Step 3: Populate transaction
const { transaction } = await populateProvedTransfer(
  TXIDVersion.V2_PoseidonMerkle,
  networkName,
  railgunWalletID,
  false,                    // showSenderAddressToRecipient
  undefined,                // memoText
  erc20AmountRecipients,
  [],                       // nftAmountRecipients
  undefined,                // broadcasterFeeERC20AmountRecipient
  true,                     // sendWithPublicWallet
  undefined,                // overallBatchMinGasPrice
  gasDetails
);

// Step 4: Submit with ethers/wagmi
const txResponse = await signer.sendTransaction(transaction);
```

#### Unshield (0zk → 0x)

```typescript
import {
  generateUnshieldProof,
  populateProvedUnshield,
  gasEstimateForUnprovenUnshield,
} from '@railgun-community/wallet';

// Step 1: Estimate gas
const gasEstimate = await gasEstimateForUnprovenUnshield(
  TXIDVersion.V2_PoseidonMerkle,
  networkName,
  railgunWalletID,
  encryptionKey,
  erc20AmountRecipients,    // [{ tokenAddress, amount, recipientAddress }]
  [],                       // nftAmountRecipients
  originalGasDetails,
  undefined,                // feeTokenDetails
  true                      // sendWithPublicWallet
);

// Step 2: Generate proof (20-30 seconds in browser)
await generateUnshieldProof(
  TXIDVersion.V2_PoseidonMerkle,
  networkName,
  railgunWalletID,
  encryptionKey,
  erc20AmountRecipients,
  [],                       // nftAmountRecipients
  undefined,                // broadcasterFeeERC20AmountRecipient
  true,                     // sendWithPublicWallet
  undefined,                // overallBatchMinGasPrice
  (progress) => console.log(`Proof: ${progress}%`)
);

// Step 3: Populate transaction
const { transaction } = await populateProvedUnshield(
  TXIDVersion.V2_PoseidonMerkle,
  networkName,
  railgunWalletID,
  erc20AmountRecipients,
  [],                       // nftAmountRecipients
  undefined,                // broadcasterFeeERC20AmountRecipient
  true,                     // sendWithPublicWallet
  undefined,                // overallBatchMinGasPrice
  gasDetails
);

// Step 4: Submit with ethers/wagmi
const txResponse = await signer.sendTransaction(transaction);
```

**Key Parameters:**
- `TXIDVersion.V2_PoseidonMerkle` - Our contract version
- `networkName` - Must match registered network (e.g., 'Hardhat')
- `sendWithPublicWallet: true` - We're not using broadcasters/relayers for proof submission
- `erc20AmountRecipients` - Array of `{ tokenAddress: string, amount: bigint, recipientAddress: string }`
  - For transfers: `recipientAddress` is a 0zk... Railgun address
  - For unshields: `recipientAddress` is a 0x... Ethereum address

**Important Notes:**
- Proof generation takes 20-30 seconds in browser (WASM). Show progress to users.
- The prover MUST be initialized before calling `generateTransferProof` or `generateUnshieldProof`
- After unshield to Hub, call `HubUnshieldProxy.bridgeTo()` for cross-chain withdrawal

## UI Mockup

```
┌─────────────────────────────────────────────────────────────────────┐
│  Railgun POC Demo                      [Client A ▼]  [0xABC...] 🔓  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Shielded Balance                                             │  │
│  │                                                               │  │
│  │       💰 1,234.56 USDC                                        │  │
│  │                                                               │  │
│  │  Shielded Address: 0zk1abc...def                    [Copy]    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────┐  ┌─────────────────────────────────┐  │
│  │  Deposit                │  │  Pay                             │  │
│  │                         │  │                                  │  │
│  │  From: [Client A    ▼]  │  │  To: [0x... or 0zk...        ]  │  │
│  │                         │  │                                  │  │
│  │  Amount: [________] USDC│  │  Amount: [________] USDC         │  │
│  │                         │  │                                  │  │
│  │  Public balance: 500.00 │  │  Destination: [Hub Chain    ▼]  │  │
│  │                         │  │  (shown only for 0x addresses)   │  │
│  │  [    Deposit    ]      │  │                                  │  │
│  │                         │  │  [      Send      ]              │  │
│  └─────────────────────────┘  └─────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Test Faucet                                                  │  │
│  │                                                               │  │
│  │  [Get tokens on Client A]  [Get tokens on Client B]  [Hub]    │  │
│  │                                                               │  │
│  │  Your public balances:                                        │  │
│  │  • Client A: 500.00 USDC, 9.5 ETH                            │  │
│  │  • Client B: 0.00 USDC, 10.0 ETH                             │  │
│  │  • Hub: 0.00 USDC, 10.0 ETH                                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Recent Transactions                                          │  │
│  │                                                               │  │
│  │  ✓ Deposited 100 USDC from Client A           2 min ago      │  │
│  │  ✓ Sent 50 USDC to 0zk...                     5 min ago      │  │
│  │  ⏳ Withdrawing 25 USDC to 0x... on Client B  pending...     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ⚠️ POC Demo - Use test funds only                                  │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Project Setup & Wallet Connection
1. Initialize Vite + React + TypeScript project
2. Configure Tailwind CSS
3. Set up wagmi for MetaMask connection
4. Create chain configuration loader
5. Build Header and ConnectButton components

### Phase 2: Shielded Wallet Integration
1. Implement key derivation from MetaMask signature
2. Create keyManager for closure-based key storage
3. Integrate with SDK to create wallet from derived keys
4. Build UnlockPrompt and WalletStatus components
5. Implement auto-lock behavior

### Phase 3: Balance Display
1. Implement merkle tree scanning via SDK
2. Create useBalance hook for shielded balance
3. Create usePublicBalance hook for per-chain USDC
4. Build BalanceCard and PublicBalance components

### Phase 4: Faucet
1. Create Faucet.sol contract
2. Update deployment scripts
3. Build FaucetButton component
4. Test faucet on all three chains

### Phase 5: Deposit (Shield)
1. Build DepositForm with chain selector
2. Implement direct shield flow (hub)
3. Implement cross-chain shield flow (client → hub)
4. Add transaction status tracking
5. Polling for Shield events

### Phase 6: Pay (Transfer/Unshield)

**Prerequisites:**
- Initialize Groth16 prover (`getProver().setSnarkJSGroth16(groth16)`)
- Ensure `snarkjs` is installed as a dependency

**Implementation Steps:**
1. Add prover initialization to `src/lib/railgun/prover.ts`
2. Build PayForm with recipient detection (0zk vs 0x)
3. Implement private transfer flow using SDK:
   - `gasEstimateForUnprovenTransfer()`
   - `generateTransferProof()` (show progress bar - takes 20-30s)
   - `populateProvedTransfer()`
   - Submit transaction via ethers
4. Implement unshield flow (hub destination) using SDK:
   - `gasEstimateForUnprovenUnshield()`
   - `generateUnshieldProof()` (show progress bar)
   - `populateProvedUnshield()`
   - Submit transaction via ethers
5. Implement cross-chain unshield flow (client destination):
   - First unshield to user's address on Hub
   - Then call `HubUnshieldProxy.bridgeTo(amount, recipient, destinationChainId)`
   - Relayer picks up and mints on client chain
6. Add destination chain selector for 0x recipients

**UI Considerations:**
- Show proof generation progress (0-100%)
- Disable form during proof generation
- Estimated time: "Generating proof... (~30 seconds)"

### Phase 7: Polish
1. Transaction history component
2. Error handling and user feedback
3. Loading states and progress indicators
4. Responsive design tweaks
5. Testing and bug fixes

## Dependencies

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "wagmi": "^2.x",
    "viem": "^2.x",
    "@tanstack/react-query": "^5.x",
    "@rainbow-me/rainbowkit": "^2.x",
    "zustand": "^4.x",
    "@noble/hashes": "^1.x",
    "ethers": "^6.x",
    "@railgun-community/wallet": "^x.x.x",
    "@railgun-community/shared-models": "^x.x.x",
    "snarkjs": "^0.7.x",
    "level-js": "^6.x"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.x",
    "autoprefixer": "^10.x",
    "postcss": "^8.x",
    "tailwindcss": "^3.x",
    "typescript": "^5.x",
    "vite": "^5.x"
  }
}
```

**Key SDK Dependencies:**
- `@railgun-community/wallet` - Main Railgun wallet SDK
- `@railgun-community/shared-models` - Shared types and models
- `snarkjs` - Groth16 prover for browser (WASM-based)
- `level-js` - IndexedDB-backed database for browser

## Open Questions

1. ~~**SDK Import Strategy**: Should the demo app import from `../lib/sdk` directly, or should we publish the SDK as a local package?~~ **RESOLVED:** Using `@railgun-community/wallet` SDK directly.

2. ~~**Proof Generation Location**: Client-side proof generation may be slow.~~ **RESOLVED:** Yes, 20-30 seconds in browser. Show progress indicator to users.

3. **Persistence**: Should we persist any state (transaction history, last used chain) to localStorage? Probably yes for better UX, but keys never persisted.

4. **Error Recovery**: If a cross-chain transaction fails mid-way (e.g., relayer down), how do we handle it? For POC, just show error and let user retry.

5. ~~**Hub Direct Shield**: Should we support shielding directly on the hub chain?~~ **RESOLVED:** Yes, implemented. Direct shield calls `RailgunSmartWallet.shield()` directly.

## Testing Checklist

- [ ] Can connect MetaMask
- [ ] Can derive shielded wallet from signature
- [ ] Same signature produces same shielded address
- [ ] Can view shielded balance (starts at 0)
- [ ] Can request tokens from faucet on each chain
- [ ] Can deposit from Client A
- [ ] Can deposit from Client B
- [ ] Can deposit from Hub (direct shield)
- [ ] Shielded balance updates after deposit
- [ ] Can send to another shielded address
- [ ] Can send to public address on Hub
- [ ] Can send to public address on Client A
- [ ] Can send to public address on Client B
- [ ] Transaction status shows correctly
- [ ] Auto-lock works after inactivity
- [ ] Page refresh requires re-unlock
