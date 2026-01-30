# Phase 2: Multi-Chain Local Setup - Implementation Plan

Add a third Anvil instance (second client chain) to validate the multi-chain architecture before testnet deployment.

## Goal

Test the full cross-chain flow:
```
Chain A (Client 1)  ──shield──▶  Hub  ──unshield──▶  Chain B (Client 2)
```

This validates that:
1. Shield from any client chain routes to the hub
2. Unshield can target any client chain
3. Relayer handles N source chains dynamically

## Architecture Overview

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│   Client Chain A    │     │     Hub Chain       │     │   Client Chain B    │
│   (port 8545)       │     │   (port 8546)       │     │   (port 8547)       │
│   chainId: 31337    │     │   chainId: 31338    │     │   chainId: 31339    │
├─────────────────────┤     ├─────────────────────┤     ├─────────────────────┤
│ MockUSDC            │     │ MockUSDC            │     │ MockUSDC            │
│ ClientShieldProxyV2 │────▶│ HubCCTPReceiverV2   │     │ ClientShieldProxyV2 │
│                     │     │ RailgunSmartWallet  │     │                     │
│                     │◀────│ HubUnshieldProxy    │────▶│                     │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
         │                           │                           │
         └───────────────────────────┼───────────────────────────┘
                                     │
                              ┌──────┴──────┐
                              │   Relayer   │
                              │ (N chains)  │
                              └─────────────┘
```

## Implementation Steps

### Step 1: Update Chain Configuration

**File: `scripts/setup_chains.sh`**

Add third Anvil instance:
```bash
#!/bin/bash
# Start three local Anvil chains

cleanup() {
    echo "Shutting down chains..."
    kill $PID_CLIENT_A $PID_HUB $PID_CLIENT_B 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "Starting Client Chain A (port 8545, chainId 31337)..."
anvil --port 8545 --chain-id 31337 --block-time 1 &
PID_CLIENT_A=$!

echo "Starting Hub Chain (port 8546, chainId 31338)..."
anvil --port 8546 --chain-id 31338 --block-time 1 &
PID_HUB=$!

echo "Starting Client Chain B (port 8547, chainId 31339)..."
anvil --port 8547 --chain-id 31339 --block-time 1 &
PID_CLIENT_B=$!

echo ""
echo "=== Three chains running ==="
echo "  Client A: http://localhost:8545 (chainId: 31337)"
echo "  Hub:      http://localhost:8546 (chainId: 31338)"
echo "  Client B: http://localhost:8547 (chainId: 31339)"
echo ""
echo "Press Ctrl+C to stop all chains"

wait
```

### Step 2: Update Hardhat Configuration

**File: `hardhat.config.ts`**

Add third network:
```typescript
networks: {
  // Client Chain A
  client: {
    url: process.env.CLIENT_RPC || "http://localhost:8545",
    chainId: 31337,
    accounts: [DEPLOYER_PRIVATE_KEY],
  },
  // Hub Chain
  hub: {
    url: process.env.HUB_RPC || "http://localhost:8546",
    chainId: 31338,
    accounts: [DEPLOYER_PRIVATE_KEY],
  },
  // Client Chain B
  clientB: {
    url: process.env.CLIENT_B_RPC || "http://localhost:8547",
    chainId: 31339,
    accounts: [DEPLOYER_PRIVATE_KEY],
  },
},
```

### Step 3: Update Relayer Configuration

**File: `relayer/config.ts`**

Refactor to support N client chains:
```typescript
export interface ChainConfig {
  rpc: string;
  chainId: number;
  name: string;
  isHub?: boolean;
}

export const config = {
  // Hub chain (single)
  hubChain: {
    rpc: "http://localhost:8546",
    chainId: 31338,
    name: "Hub",
    isHub: true,
  } as ChainConfig,

  // Client chains (array for N chains)
  clientChains: [
    {
      rpc: "http://localhost:8545",
      chainId: 31337,
      name: "Client A",
    },
    {
      rpc: "http://localhost:8547",
      chainId: 31339,
      name: "Client B",
    },
  ] as ChainConfig[],

  // All chains (computed)
  get allChains(): ChainConfig[] {
    return [this.hubChain, ...this.clientChains];
  },

  // Accounts (unchanged)
  accounts: {
    deployer: {
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    },
    user1: {
      privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    },
    user2: {
      privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    },
  },
};

// Helper to get chain by ID
export function getChainById(chainId: number): ChainConfig | undefined {
  return config.allChains.find(c => c.chainId === chainId);
}

// Helper to check if chain is hub
export function isHubChain(chainId: number): boolean {
  return chainId === config.hubChain.chainId;
}
```

### Step 4: Update Relayer Implementation

**File: `relayer/relay.ts`**

Refactor to handle N chains dynamically:

```typescript
import { ethers } from "ethers";
import { config, ChainConfig, getChainById, isHubChain } from "./config";

interface ChainState {
  config: ChainConfig;
  provider: ethers.JsonRpcProvider;
  signer: ethers.Wallet;
  mockUSDC: ethers.Contract;
  processedNonces: Set<string>;
}

class MultiChainRelayer {
  private chains: Map<number, ChainState> = new Map();
  private hubChain!: ChainState;

  async initialize() {
    console.log("Initializing Multi-Chain Relayer...\n");

    // Initialize hub chain
    this.hubChain = await this.initChain(config.hubChain);
    this.chains.set(config.hubChain.chainId, this.hubChain);

    // Initialize all client chains
    for (const clientConfig of config.clientChains) {
      const chain = await this.initChain(clientConfig);
      this.chains.set(clientConfig.chainId, chain);
    }

    console.log(`\nRelayer initialized for ${this.chains.size} chains`);
  }

  private async initChain(chainConfig: ChainConfig): Promise<ChainState> {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
    const signer = new ethers.Wallet(config.accounts.deployer.privateKey, provider);

    // Load deployment to get MockUSDC address
    const deploymentFile = chainConfig.isHub ? "hub.json" :
      chainConfig.chainId === 31337 ? "client.json" : "clientB.json";
    const deployment = loadDeployment(deploymentFile);

    const mockUSDC = new ethers.Contract(
      deployment.contracts.mockUSDC,
      MOCK_USDC_ABI,
      signer
    );

    console.log(`  ${chainConfig.name}: ${chainConfig.rpc} (chainId: ${chainConfig.chainId})`);

    return {
      config: chainConfig,
      provider,
      signer,
      mockUSDC,
      processedNonces: new Set(),
    };
  }

  async start() {
    console.log("\nStarting relay loops...\n");

    // Poll all chains for burn events
    for (const [chainId, chain] of this.chains) {
      this.pollChain(chain);
    }
  }

  private async pollChain(chain: ChainState) {
    const filter = chain.mockUSDC.filters.BurnForDeposit();

    console.log(`Polling ${chain.config.name} for BurnForDeposit events...`);

    while (true) {
      try {
        const events = await chain.mockUSDC.queryFilter(filter, -100, "latest");

        for (const event of events) {
          const log = event as ethers.EventLog;
          const nonce = log.args.nonce.toString();
          const nonceKey = `${chain.config.chainId}-${nonce}`;

          if (!chain.processedNonces.has(nonceKey)) {
            chain.processedNonces.add(nonceKey);
            await this.relayBurn(chain, log);
          }
        }
      } catch (e: any) {
        console.error(`Error polling ${chain.config.name}:`, e.message);
      }

      await sleep(1000);
    }
  }

  private async relayBurn(sourceChain: ChainState, event: ethers.EventLog) {
    const { from, amount, destinationChainId, recipient, payload, nonce } = event.args;

    console.log(`\n[${sourceChain.config.name}] BurnForDeposit detected:`);
    console.log(`  From: ${from}`);
    console.log(`  Amount: ${ethers.formatUnits(amount, 6)} USDC`);
    console.log(`  Destination: Chain ${destinationChainId}`);
    console.log(`  Recipient: ${recipient}`);
    console.log(`  Nonce: ${nonce}`);

    // Get destination chain
    const destChainId = Number(destinationChainId);
    const destChain = this.chains.get(destChainId);

    if (!destChain) {
      console.error(`  ERROR: Unknown destination chain ${destChainId}`);
      return;
    }

    console.log(`  Relaying to ${destChain.config.name}...`);

    try {
      // Build message for receiveMessage
      const message = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [from, amount, payload]
      );

      // Call receiveMessage on destination MockUSDC
      const tx = await destChain.mockUSDC.receiveMessage(
        sourceChain.config.chainId,
        recipient,
        message
      );
      const receipt = await tx.wait();

      console.log(`  Relayed successfully! Tx: ${tx.hash}`);
    } catch (e: any) {
      console.error(`  Relay failed: ${e.message}`);
    }
  }
}

// Entry point
const relayer = new MultiChainRelayer();
relayer.initialize().then(() => relayer.start());
```

### Step 5: Create Client B Deployment Script

**File: `scripts/deploy_clientB.ts`**

Copy and adapt from `deploy_client.ts`:
```typescript
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("=== Deploying to Client Chain B ===\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${network.chainId}`);

  // Deploy MockUSDC
  console.log("Deploying MockUSDC...");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = await MockUSDC.deploy("Mock USDC", "USDC");
  await mockUSDC.waitForDeployment();
  const mockUSDCAddress = await mockUSDC.getAddress();
  console.log(`MockUSDC deployed to: ${mockUSDCAddress}`);

  // Mint initial USDC to test users
  console.log("\nMinting initial USDC to test users...");
  const testUsers = [
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  ];
  const mintAmount = ethers.parseUnits("10000", 6);

  for (const user of testUsers) {
    const tx = await mockUSDC.mint(user, mintAmount);
    await tx.wait();
    console.log(`  Minted ${ethers.formatUnits(mintAmount, 6)} USDC to ${user}`);
  }

  // Save deployment
  const deploymentInfo = {
    chainId: Number(network.chainId),
    deployer: deployer.address,
    contracts: {
      mockUSDC: mockUSDCAddress,
    },
    timestamp: new Date().toISOString(),
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(deploymentsDir, "clientB.json"),
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("\nDeployment info saved to deployments/clientB.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
```

### Step 6: Update V2 Deployment Script

**File: `scripts/deploy_v2.ts`**

Add support for Client B (chainId 31339):
```typescript
// Update the chain detection logic:
const isClientChainA = chainId === 31337;
const isClientChainB = chainId === 31339;
const isHubChain = chainId === 31338;
const isClientChain = isClientChainA || isClientChainB;

// In the client chain deployment section:
if (isClientChain) {
  const deploymentName = isClientChainA ? "client" : "clientB";
  const clientDeployment = loadDeployment(deploymentName);
  // ... rest of deployment logic
  saveDeployment(deploymentName, clientDeployment);
}
```

### Step 7: Update Link Deployments Script

**File: `scripts/link_deployments.ts`**

Add support for linking Client B:
```typescript
// Add after the Client A linking:
const clientBDeploymentPath = path.join(deploymentsDir, "clientB.json");

if (fs.existsSync(clientBDeploymentPath)) {
  const clientBDeployment = JSON.parse(fs.readFileSync(clientBDeploymentPath, "utf-8"));

  if (clientBDeployment.contracts.clientShieldProxyV2) {
    // Link Client B's proxy to hub receiver
    // Similar logic as Client A
  }
}
```

### Step 8: Update package.json Scripts

Add new npm scripts:
```json
{
  "scripts": {
    "deploy:clientB": "hardhat run scripts/deploy_clientB.ts --network clientB",
    "deploy:v2:clientB": "hardhat run scripts/deploy_v2.ts --network clientB",
    "link:clientB": "hardhat run scripts/link_deployments.ts --network clientB",
    "deploy:all": "npm run deploy:hub && npm run deploy:client && npm run deploy:clientB && npm run deploy:railgun && npm run deploy:unshield-proxy && npm run deploy:v2 && npm run deploy:v2:clientB && npm run link && npm run link:clientB",
    "test:multichain": "npx ts-node test/e2e_multichain.ts"
  }
}
```

### Step 9: Create Multi-Chain Test

**File: `test/e2e_multichain.ts`**

Test the full cross-chain flow:
```typescript
/**
 * E2E Multi-Chain Test
 *
 * Flow: Shield on Chain A → Private Transfer on Hub → Unshield to Chain B
 *
 * Prerequisites:
 * - All three chains running (npm run chains)
 * - All contracts deployed (npm run setup)
 * - Relayer running (npm run relayer)
 */

async function main() {
  console.log("=== MULTI-CHAIN E2E TEST ===\n");
  console.log("Flow: Chain A → Hub → Chain B\n");

  // Step 1: Check initial balances on all chains
  console.log("--- Step 1: Initial Balances ---");
  const aliceBalanceA = await getUSDCBalance("client", alice);
  const aliceBalanceB = await getUSDCBalance("clientB", alice);
  console.log(`Alice on Chain A: ${formatUSDC(aliceBalanceA)} USDC`);
  console.log(`Alice on Chain B: ${formatUSDC(aliceBalanceB)} USDC`);

  // Step 2: Shield from Chain A
  console.log("\n--- Step 2: Shield from Chain A ---");
  const shieldAmount = parseUSDC("100");
  await shieldFromChain("client", alice, shieldAmount);
  // Wait for relayer and verify commitment

  // Step 3: Private transfer (optional, same as existing test)
  console.log("\n--- Step 3: Private Transfer on Hub ---");
  // Transfer to Bob if desired

  // Step 4: Unshield to Chain B
  console.log("\n--- Step 4: Unshield to Chain B ---");
  const unshieldAmount = parseUSDC("50");
  const destChainId = 31339; // Client B
  await unshieldToChain(alice, unshieldAmount, destChainId);
  // Wait for relayer

  // Step 5: Verify final balances
  console.log("\n--- Step 5: Final Balances ---");
  const finalBalanceA = await getUSDCBalance("client", alice);
  const finalBalanceB = await getUSDCBalance("clientB", alice);
  console.log(`Alice on Chain A: ${formatUSDC(finalBalanceA)} USDC (should be -100)`);
  console.log(`Alice on Chain B: ${formatUSDC(finalBalanceB)} USDC (should be +50)`);

  // Verify
  assert(finalBalanceA < aliceBalanceA, "Chain A balance should decrease");
  assert(finalBalanceB > aliceBalanceB, "Chain B balance should increase");

  console.log("\n=== MULTI-CHAIN TEST PASSED ===");
}
```

### Step 10: Update SDK Chain Configuration

**File: `lib/sdk/chain-config.ts`**

Add Client B chain:
```typescript
export const CLIENT_B_CHAIN: Chain = {
  type: ChainType.EVM,
  id: 31339,
};

export function getChainConfig(chainId: number): Chain {
  switch (chainId) {
    case 31337: return CLIENT_CHAIN;
    case 31338: return HUB_CHAIN;
    case 31339: return CLIENT_B_CHAIN;
    default: throw new Error(`Unknown chain ID: ${chainId}`);
  }
}
```

## Deployment Checklist

Run these commands in order after implementing all changes:

```bash
# 1. Clean previous state
npm run clean

# 2. Start all three chains (keep terminal open)
npm run chains

# 3. Deploy all contracts (new terminal)
npm run setup

# 4. Start relayer (new terminal)
npm run relayer

# 5. Run multi-chain test (new terminal)
npm run test:multichain
```

## Expected Output

```
=== MULTI-CHAIN E2E TEST ===

Flow: Chain A → Hub → Chain B

--- Step 1: Initial Balances ---
Alice on Chain A: 10000.00 USDC
Alice on Chain B: 10000.00 USDC

--- Step 2: Shield from Chain A ---
Calling ClientShieldProxyV2.shield() on Chain A...
Shield tx: 0x...
Waiting for relayer to process...
Commitment added to Railgun merkle tree

--- Step 3: Private Transfer on Hub ---
(Optional transfer step)

--- Step 4: Unshield to Chain B ---
Creating unshield proof targeting Chain B (31339)...
Calling RailgunSmartWallet.transact()...
Waiting for relayer to relay to Chain B...
USDC minted on Chain B

--- Step 5: Final Balances ---
Alice on Chain A: 9900.00 USDC (should be -100)
Alice on Chain B: 10050.00 USDC (should be +50)

=== MULTI-CHAIN TEST PASSED ===
```

## Files to Create/Modify Summary

| File | Action | Description |
|------|--------|-------------|
| `scripts/setup_chains.sh` | Modify | Add third Anvil instance |
| `hardhat.config.ts` | Modify | Add `clientB` network |
| `relayer/config.ts` | Modify | Refactor for N client chains |
| `relayer/relay.ts` | Modify | Handle multiple chains dynamically |
| `scripts/deploy_clientB.ts` | Create | Deploy contracts to Client B |
| `scripts/deploy_v2.ts` | Modify | Support chainId 31339 |
| `scripts/link_deployments.ts` | Modify | Link Client B proxy |
| `package.json` | Modify | Add new npm scripts |
| `test/e2e_multichain.ts` | Create | Multi-chain E2E test |
| `lib/sdk/chain-config.ts` | Modify | Add Client B chain config |

## Verification Points

1. **Three chains running**: All three Anvil instances start successfully
2. **Contracts deployed**: `deployments/clientB.json` created with correct addresses
3. **Relayer handles all chains**: Logs show polling for all three chains
4. **Shield routes correctly**: Burns on Chain A/B route to Hub
5. **Unshield targets correctly**: Unshield to Chain B mints on Chain B (not A)
6. **Balances reconcile**: Final balances match expected values

## Next Phase Preview

After validating locally with three chains, Phase 3 would involve:
- Deploy to Sepolia (testnet)
- Test with real CCTP (Circle attestations)
- Add multiple token support
- Production relayer infrastructure
