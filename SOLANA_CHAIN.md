# Solana Client Chain Implementation Plan

This document outlines the plan to add a Solana client chain to the Railgun CCTP POC, enabling cross-VM (EVM ↔ Solana) shielded transfers.

## Overview

The goal is to add Solana as another client chain, allowing:
- Shield from Solana → Hub (EVM) → Railgun shielded pool
- Unshield from Railgun → Hub (EVM) → Solana

Since this is for local testing, CCTP messages are simulated (not using actual Circle infrastructure).

## Prerequisites

- Rust toolchain installed (`rustup`)
- Solana CLI tools (`solana`, `solana-test-validator`)
- Anchor framework (`anchor`)
- Node.js dependencies: `@solana/web3.js`, `@coral-xyz/anchor`

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Solana        │     │   Hub (EVM)     │     │  Client A (EVM) │
│   Chain         │     │   Chain 31338   │     │  Chain 31337    │
│                 │     │                 │     │                 │
│ MockUSDC (SPL)  │     │ MockUSDC        │     │ MockUSDC        │
│ ShieldProxy     │────▶│ HubCCTPReceiver │     │ ShieldProxy     │
│                 │     │ Railgun         │     │                 │
│                 │◀────│ HubUnshieldProxy│     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        └───────────────────────┴───────────────────────┘
                            Relayer
                    (polls all chains, relays messages)
```

## Implementation Steps

### Phase 1: Solana Development Environment

#### Step 1: Install Solana Toolchain

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.18.0/install)"

# Install Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest
```

#### Step 2: Initialize Anchor Project

Create a new Anchor workspace for Solana programs:

```bash
cd poc
mkdir -p solana
cd solana
anchor init railgun-cctp-solana --javascript
```

### Phase 2: Solana Programs (Rust/Anchor)

#### Step 3: MockUSDC Program

Create `solana/programs/mock-usdc/src/lib.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Burn};

declare_id!("MockUSDC111111111111111111111111111111111");

#[program]
pub mod mock_usdc {
    use super::*;

    /// Initialize the mock USDC mint
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    /// Mint tokens to an account (for testing)
    pub fn mint_to(ctx: Context<MintTo>, amount: u64) -> Result<()> {
        // Mint logic
        Ok(())
    }

    /// Burn tokens and emit a "deposit" event for CCTP simulation
    /// This simulates CCTP's depositForBurn
    pub fn burn_for_deposit(
        ctx: Context<BurnForDeposit>,
        amount: u64,
        destination_chain_id: u32,
        recipient: [u8; 32],  // EVM address padded to 32 bytes
        payload: Vec<u8>,
    ) -> Result<()> {
        // Burn the tokens
        let cpi_accounts = Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.from.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::burn(cpi_ctx, amount)?;

        // Emit event for relayer to pick up
        emit!(BurnForDepositEvent {
            nonce: ctx.accounts.state.next_nonce,
            sender: ctx.accounts.authority.key(),
            amount,
            destination_chain_id,
            recipient,
            payload,
        });

        // Increment nonce
        ctx.accounts.state.next_nonce += 1;

        Ok(())
    }

    /// Receive a message from another chain (called by relayer)
    /// This simulates CCTP's receiveMessage
    pub fn receive_message(
        ctx: Context<ReceiveMessage>,
        source_chain_id: u32,
        nonce: u64,
        sender: [u8; 32],
        amount: u64,
        recipient: Pubkey,
        payload: Vec<u8>,
    ) -> Result<()> {
        // Mint tokens to recipient (simulating CCTP mint)
        // In real CCTP, this would verify attestation

        emit!(MessageReceivedEvent {
            source_chain_id,
            nonce,
            sender,
            amount,
            recipient,
            payload,
        });

        Ok(())
    }
}

#[event]
pub struct BurnForDepositEvent {
    pub nonce: u64,
    pub sender: Pubkey,
    pub amount: u64,
    pub destination_chain_id: u32,
    pub recipient: [u8; 32],
    pub payload: Vec<u8>,
}

#[event]
pub struct MessageReceivedEvent {
    pub source_chain_id: u32,
    pub nonce: u64,
    pub sender: [u8; 32],
    pub amount: u64,
    pub recipient: Pubkey,
    pub payload: Vec<u8>,
}

// Account structures...
#[derive(Accounts)]
pub struct Initialize<'info> {
    // ...
}

#[derive(Accounts)]
pub struct BurnForDeposit<'info> {
    #[account(mut)]
    pub state: Account<'info, CctpState>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub from: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReceiveMessage<'info> {
    #[account(mut)]
    pub state: Account<'info, CctpState>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    /// CHECK: Recipient token account
    #[account(mut)]
    pub recipient_token_account: AccountInfo<'info>,
    pub relayer: Signer<'info>,  // Only authorized relayer can call
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct CctpState {
    pub next_nonce: u64,
    pub relayer: Pubkey,
}
```

#### Step 4: ClientShieldProxy Program

Create `solana/programs/client-shield-proxy/src/lib.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Shield11111111111111111111111111111111111");

#[program]
pub mod client_shield_proxy {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        hub_chain_id: u32,
        hub_receiver: [u8; 32],  // EVM address of HubCCTPReceiverV2
    ) -> Result<()> {
        ctx.accounts.config.hub_chain_id = hub_chain_id;
        ctx.accounts.config.hub_receiver = hub_receiver;
        Ok(())
    }

    /// Shield USDC - burns locally and sends to Hub for Railgun deposit
    pub fn shield(
        ctx: Context<Shield>,
        amount: u64,
        npk: [u8; 32],              // Railgun NPK
        encrypted_bundle: Vec<u8>,   // Encrypted note data
        shield_key: [u8; 32],        // Shield key
    ) -> Result<()> {
        // Transfer USDC from user to this program
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Build payload for Hub (Railgun shield request)
        let payload = build_shield_payload(npk, encrypted_bundle.clone(), shield_key);

        // Call MockUSDC burn_for_deposit (CPI)
        // This emits the event that relayer picks up

        emit!(ShieldInitiatedEvent {
            user: ctx.accounts.user.key(),
            amount,
            npk,
            encrypted_bundle,
            shield_key,
            destination_chain_id: ctx.accounts.config.hub_chain_id,
        });

        Ok(())
    }
}

fn build_shield_payload(
    npk: [u8; 32],
    encrypted_bundle: Vec<u8>,
    shield_key: [u8; 32],
) -> Vec<u8> {
    // ABI-encode the shield request for EVM Hub
    // Format must match HubCCTPReceiverV2.receiveMessage expectations
    let mut payload = Vec::new();
    payload.extend_from_slice(&npk);
    // ... encode rest of payload
    payload
}

#[event]
pub struct ShieldInitiatedEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub npk: [u8; 32],
    pub encrypted_bundle: Vec<u8>,
    pub shield_key: [u8; 32],
    pub destination_chain_id: u32,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + ShieldConfig::SIZE)]
    pub config: Account<'info, ShieldConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Shield<'info> {
    #[account(mut)]
    pub config: Account<'info, ShieldConfig>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: MockUSDC program for CPI
    pub mock_usdc_program: AccountInfo<'info>,
}

#[account]
pub struct ShieldConfig {
    pub hub_chain_id: u32,
    pub hub_receiver: [u8; 32],
}

impl ShieldConfig {
    pub const SIZE: usize = 4 + 32;
}
```

### Phase 3: Local Validator Setup

#### Step 5: Update setup_chains.sh

Add Solana test validator to the chain setup script:

```bash
# Add to setup_chains.sh

# Start Solana test validator
echo "Starting Solana test validator..."
solana-test-validator \
  --reset \
  --quiet \
  --bpf-program MockUSDC111111111111111111111111111111111 solana/target/deploy/mock_usdc.so \
  --bpf-program Shield11111111111111111111111111111111111 solana/target/deploy/client_shield_proxy.so \
  &
SOLANA_PID=$!
echo "Solana validator started (PID: $SOLANA_PID)"

# Wait for Solana to be ready
sleep 5
solana config set --url http://localhost:8899
```

#### Step 6: Solana Deployment Script

Create `solana/scripts/deploy.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MockUsdc } from "../target/types/mock_usdc";
import { ClientShieldProxy } from "../target/types/client_shield_proxy";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Deploy and initialize MockUSDC
  const mockUsdcProgram = anchor.workspace.MockUsdc as Program<MockUsdc>;
  // ... initialization

  // Deploy and initialize ClientShieldProxy
  const shieldProxyProgram = anchor.workspace.ClientShieldProxy as Program<ClientShieldProxy>;

  const hubChainId = 31338;
  const hubReceiver = "0x..."; // HubCCTPReceiverV2 address, padded to 32 bytes

  // ... initialization

  // Save deployment info
  const deployment = {
    network: "localnet",
    programs: {
      mockUsdc: mockUsdcProgram.programId.toBase58(),
      clientShieldProxy: shieldProxyProgram.programId.toBase58(),
    },
    accounts: {
      // PDAs and token accounts
    },
  };

  fs.writeFileSync(
    "../deployments/solana.json",
    JSON.stringify(deployment, null, 2)
  );
}

main();
```

### Phase 4: Relayer Updates

#### Step 7: Add Solana Support to Relayer Config

Update `relayer/config.ts`:

```typescript
import { Connection, Keypair } from "@solana/web3.js";

// Existing EVM chain configs...

// Solana chain configuration
export const solanaChain = {
  rpc: "http://localhost:8899",
  wsRpc: "ws://localhost:8900",
  name: "Solana",
  deploymentFile: "solana.json",
  chainType: "solana" as const,
};

// Update allChains to include chain type
export interface ChainConfig {
  rpc: string;
  chainId?: number;      // For EVM chains
  name: string;
  deploymentFile: string;
  chainType: "evm" | "solana";
}

export const allChains: ChainConfig[] = [
  { ...hubChain, chainType: "evm" },
  ...clientChains.map(c => ({ ...c, chainType: "evm" as const })),
  solanaChain,
];
```

#### Step 8: Solana Event Polling

Create `relayer/solana-poller.ts`:

```typescript
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

const SHIELD_PROXY_PROGRAM_ID = new PublicKey("Shield11111111111111111111111111111111111");

export async function pollSolanaBurnEvents(
  connection: Connection,
  lastSignature: string | null
): Promise<BurnEvent[]> {
  // Get recent transactions for the program
  const signatures = await connection.getSignaturesForAddress(
    SHIELD_PROXY_PROGRAM_ID,
    { until: lastSignature || undefined }
  );

  const events: BurnEvent[] = [];

  for (const sig of signatures) {
    const tx = await connection.getTransaction(sig.signature, {
      commitment: "confirmed",
    });

    if (!tx?.meta?.logMessages) continue;

    // Parse Anchor events from logs
    const event = parseShieldInitiatedEvent(tx.meta.logMessages);
    if (event) {
      events.push({
        signature: sig.signature,
        ...event,
      });
    }
  }

  return events;
}

function parseShieldInitiatedEvent(logs: string[]): ShieldEventData | null {
  // Anchor events are base64 encoded in logs
  // Look for "Program data: <base64>" entries
  for (const log of logs) {
    if (log.startsWith("Program data:")) {
      const data = log.slice("Program data: ".length);
      // Decode and parse the event
      // ...
    }
  }
  return null;
}

interface BurnEvent {
  signature: string;
  user: string;
  amount: bigint;
  npk: Uint8Array;
  encryptedBundle: Uint8Array;
  shieldKey: Uint8Array;
  destinationChainId: number;
}
```

#### Step 9: Update Main Relay Loop

Update `relayer/relay.ts`:

```typescript
import { Connection, Keypair } from "@solana/web3.js";
import { pollSolanaBurnEvents } from "./solana-poller";

// Add Solana connection
const solanaConnection = new Connection(solanaChain.rpc, "confirmed");
let lastSolanaSignature: string | null = null;

async function pollAllChains() {
  // Existing EVM polling...

  // Poll Solana
  const solanaEvents = await pollSolanaBurnEvents(
    solanaConnection,
    lastSolanaSignature
  );

  for (const event of solanaEvents) {
    console.log(`\nSolana: Found shield event in tx ${event.signature}`);

    if (event.destinationChainId === hubChain.chainId) {
      // Relay Solana → Hub
      await relaySolanaToHub(event);
    }

    lastSolanaSignature = event.signature;
  }
}

async function relaySolanaToHub(event: SolanaBurnEvent) {
  console.log("Relaying Solana → Hub");

  // Convert Solana event data to EVM format
  const payload = encodeHubPayload(
    event.npk,
    event.encryptedBundle,
    event.shieldKey
  );

  // Call HubCCTPReceiverV2.receiveMessage on Hub
  const hubReceiver = new ethers.Contract(
    hubDeployment.contracts.hubCCTPReceiverV2,
    HUB_CCTP_RECEIVER_ABI,
    hubWallet
  );

  const tx = await hubReceiver.receiveMessage(
    0, // Solana "chain ID" (we can use 0 or a custom identifier)
    event.nonce,
    event.user,  // Solana pubkey as bytes32
    event.amount,
    payload
  );

  await tx.wait();
  console.log("✓ Relayed to Hub");
}

async function relayHubToSolana(event: HubBurnEvent) {
  console.log("Relaying Hub → Solana");

  // Call Solana MockUSDC receive_message
  const program = anchor.workspace.MockUsdc;

  const tx = await program.methods
    .receiveMessage(
      hubChain.chainId,
      event.nonce,
      event.sender,
      event.amount,
      new PublicKey(event.recipient),
      event.payload
    )
    .accounts({
      // ... required accounts
    })
    .rpc();

  console.log(`✓ Relayed to Solana: ${tx}`);
}
```

### Phase 5: Testing

#### Step 10: Multi-VM E2E Test

Create `test/e2e_solana.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";

async function main() {
  console.log("=== Solana ↔ EVM Multi-Chain Test ===\n");

  // Setup Solana connection
  const solanaConnection = new Connection("http://localhost:8899", "confirmed");
  const solanaUser = Keypair.generate();

  // Setup EVM connection (Hub)
  const hubProvider = new ethers.JsonRpcProvider("http://localhost:8546");

  // ... load deployments

  // Step 1: Airdrop SOL and USDC to Solana user
  console.log("--- Step 1: Setup Solana User ---");
  await solanaConnection.requestAirdrop(solanaUser.publicKey, 1e9);
  // Mint test USDC to user...

  // Step 2: Shield from Solana
  console.log("\n--- Step 2: Shield from Solana ---");
  const shieldAmount = 100_000_000n; // 100 USDC (6 decimals)

  const { npk, encryptedBundle, shieldKey } = await createShieldRequest(
    solanaUser.publicKey.toBase58(),
    shieldAmount
  );

  const shieldTx = await shieldProxyProgram.methods
    .shield(
      new anchor.BN(shieldAmount.toString()),
      npk,
      encryptedBundle,
      shieldKey
    )
    .accounts({
      // ...
    })
    .signers([solanaUser])
    .rpc();

  console.log(`  Shield tx: ${shieldTx}`);

  // Step 3: Wait for relayer (Solana → Hub)
  console.log("\n--- Step 3: Waiting for Relayer (Solana → Hub) ---");
  // Poll Railgun leaf index...

  // Step 4: Unshield to EVM Chain A
  console.log("\n--- Step 4: Unshield to EVM Chain A ---");
  // ... similar to existing e2e_multichain.ts

  console.log("\n=== SOLANA TEST PASSED ===");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Test failed:", e);
    process.exit(1);
  });
```

### Phase 6: Package.json Scripts

#### Step 11: Add Solana Scripts

```json
{
  "scripts": {
    "solana:build": "cd solana && anchor build",
    "solana:deploy": "cd solana && anchor deploy && node scripts/deploy.js",
    "solana:test": "npx ts-node test/e2e_solana.ts",
    "setup:all": "npm run setup:chains && npm run deploy:all && npm run solana:deploy"
  }
}
```

## Data Flow Summary

### Shield from Solana → Hub

```
1. User calls ClientShieldProxy.shield() on Solana
2. Program burns USDC, emits ShieldInitiatedEvent
3. Relayer polls Solana, sees event
4. Relayer calls HubCCTPReceiverV2.receiveMessage() on Hub (EVM)
5. Hub mints USDC, deposits to Railgun with note data
6. Commitment added to Railgun merkle tree
```

### Unshield from Hub → Solana

```
1. User generates ZK proof, calls RailgunSmartWallet.transact()
2. Railgun emits Unshield event with destinationChainId = Solana
3. User receives USDC on Hub, calls HubUnshieldProxy.bridgeTo(solana)
4. Hub burns USDC, emits burn event
5. Relayer sees burn event for Solana destination
6. Relayer calls MockUSDC.receive_message() on Solana
7. Solana mints USDC to recipient
```

## Key Differences from EVM Chains

| Aspect | EVM | Solana |
|--------|-----|--------|
| Language | Solidity | Rust/Anchor |
| Address format | 20 bytes hex | 32 bytes base58 |
| Events | Indexed logs | Program logs (base64) |
| Transaction model | Account nonces | Recent blockhash |
| Token standard | ERC-20 | SPL Token |
| RPC | JSON-RPC | JSON-RPC (different methods) |

## Estimated Effort

| Task | Estimate |
|------|----------|
| Solana toolchain setup | 2-4 hours |
| MockUSDC program | 4-8 hours |
| ClientShieldProxy program | 8-12 hours |
| Relayer Solana integration | 8-12 hours |
| Testing & debugging | 8-16 hours |
| **Total** | **30-50 hours** |

## Phase 7: Demo-App Frontend Updates

This phase covers the frontend changes needed to support shielding from Solana and unshielding to Solana in the demo-app. We assume **MetaMask-only** for Solana wallet support (via MetaMask's Solana Snap), which simplifies the implementation significantly.

### Why MetaMask-Only?

Using MetaMask for both EVM and Solana provides key advantages:

1. **Single wallet connection** - No separate Phantom/Solflare integration
2. **Unified Railgun identity** - Keys derived from EVM signature (unchanged)
3. **Simpler UX** - User already has ETH for Hub chain gas
4. **One signing interface** - MetaMask handles both EVM and Solana transactions

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    MetaMask (Multichain)                     │
│  ┌─────────────────────┐  ┌─────────────────────────┐       │
│  │ EVM Account         │  │ Solana Account          │       │
│  │ 0xABC...            │  │ 7xYz... (via Snap)      │       │
│  │                     │  │                         │       │
│  │ • Railgun keys      │  │ • Shield from Solana    │       │
│  │ • Hub transactions  │  │ • Receive unshields     │       │
│  │ • Client chain txs  │  │                         │       │
│  └─────────────────────┘  └─────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### Step 12: New Dependencies

Add Solana dependencies to `demo-app/package.json`:

```json
{
  "dependencies": {
    "@solana/web3.js": "^1.95.0",
    "@coral-xyz/anchor": "^0.30.0",
    "bs58": "^6.0.0"
  }
}
```

### Step 13: Update Chain Configuration

#### Update `src/config/chains.json`

Add Solana chain with a distinct `chainType` field:

```json
{
  "chains": [
    {
      "id": 31337,
      "name": "Hub Chain",
      "type": "hub",
      "chainType": "evm",
      "rpcUrl": "http://localhost:8545",
      "nativeCurrency": {
        "name": "Ether",
        "symbol": "ETH",
        "decimals": 18
      }
    },
    {
      "id": 31338,
      "name": "Client A",
      "type": "client",
      "chainType": "evm",
      "rpcUrl": "http://localhost:8546",
      "nativeCurrency": {
        "name": "Ether",
        "symbol": "ETH",
        "decimals": 18
      }
    },
    {
      "id": 31339,
      "name": "Client B",
      "type": "client",
      "chainType": "evm",
      "rpcUrl": "http://localhost:8547",
      "nativeCurrency": {
        "name": "Ether",
        "symbol": "ETH",
        "decimals": 18
      }
    },
    {
      "id": 999,
      "name": "Solana",
      "type": "client",
      "chainType": "solana",
      "rpcUrl": "http://localhost:8899",
      "wsRpcUrl": "ws://localhost:8900",
      "nativeCurrency": {
        "name": "SOL",
        "symbol": "SOL",
        "decimals": 9
      }
    }
  ],
  "tokens": {
    "USDC": {
      "symbol": "USDC",
      "decimals": 6
    }
  }
}
```

#### Update `src/config/index.ts`

Add chain type support and Solana-specific helpers:

```typescript
import chainsConfig from './chains.json';

export interface ChainConfig {
  id: number;
  name: string;
  type: 'hub' | 'client';
  chainType: 'evm' | 'solana';  // NEW
  rpcUrl: string;
  wsRpcUrl?: string;  // NEW - for Solana WebSocket
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  contracts?: {
    mockUSDC?: string;
    railgunProxy?: string;
    hubCCTPReceiver?: string;
    hubUnshieldProxy?: string;
    clientShieldProxy?: string;
    faucet?: string;
  };
  // Solana-specific
  programs?: {
    mockUsdc?: string;
    clientShieldProxy?: string;
    faucet?: string;
  };
  accounts?: {
    usdcMint?: string;
    shieldProxyConfig?: string;
  };
}

// ... existing code ...

// NEW: Solana helpers
export function getSolanaChain(): ChainConfig | undefined {
  return config.chains.find(c => c.chainType === 'solana');
}

export function isSolanaChain(chainId: number): boolean {
  const chain = getChainById(chainId);
  return chain?.chainType === 'solana';
}

export function getEvmChains(): ChainConfig[] {
  return config.chains.filter(c => c.chainType === 'evm');
}

// Update loadDeployments to include Solana
export async function loadDeployments(): Promise<void> {
  if (deploymentsLoaded) return;

  try {
    const [hubDeployment, clientDeployment, clientBDeployment, railgunDeployment, solanaDeployment] = await Promise.all([
      fetchDeployment('hub'),
      fetchDeployment('client'),
      fetchDeployment('clientB'),
      fetchDeployment('railgun'),
      fetchDeployment('solana'),  // NEW
    ]);

    // ... existing EVM chain setup ...

    // NEW: Update Solana chain config
    const solanaChain = config.chains.find(c => c.chainType === 'solana');
    if (solanaChain && solanaDeployment) {
      solanaChain.programs = {
        mockUsdc: solanaDeployment.programs?.mockUsdc,
        clientShieldProxy: solanaDeployment.programs?.clientShieldProxy,
        faucet: solanaDeployment.programs?.faucet,
      };
      solanaChain.accounts = {
        usdcMint: solanaDeployment.accounts?.usdcMint,
        shieldProxyConfig: solanaDeployment.accounts?.shieldProxyConfig,
      };
    }

    deploymentsLoaded = true;
  } catch (error) {
    console.warn('Failed to load deployments:', error);
  }
}
```

### Step 14: Solana Library Functions

Create `src/lib/solana/index.ts`:

```typescript
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getSolanaChain } from '../../config';

// Solana connection singleton
let connection: Connection | null = null;

export function getSolanaConnection(): Connection {
  if (!connection) {
    const solanaChain = getSolanaChain();
    if (!solanaChain) throw new Error('Solana chain not configured');
    connection = new Connection(solanaChain.rpcUrl, 'confirmed');
  }
  return connection;
}

/**
 * Get Solana address from MetaMask via Snaps
 * MetaMask must have the Solana Snap installed
 */
export async function getSolanaAddress(): Promise<string | null> {
  if (!window.ethereum) return null;

  try {
    // Request Solana accounts via MetaMask Snaps
    // Note: This requires MetaMask Flask or the Solana Snap to be installed
    const result = await window.ethereum.request({
      method: 'wallet_invokeSnap',
      params: {
        snapId: 'npm:@metamask/solana-wallet-snap',
        request: {
          method: 'getAccount',
        },
      },
    });

    return result?.address || null;
  } catch (error) {
    console.error('[solana] Failed to get Solana address from MetaMask:', error);
    return null;
  }
}

/**
 * Check if MetaMask has Solana Snap installed
 */
export async function isSolanaSnapInstalled(): Promise<boolean> {
  if (!window.ethereum) return false;

  try {
    const snaps = await window.ethereum.request({
      method: 'wallet_getSnaps',
    });
    return !!snaps?.['npm:@metamask/solana-wallet-snap'];
  } catch {
    return false;
  }
}

/**
 * Install Solana Snap if not already installed
 */
export async function installSolanaSnap(): Promise<boolean> {
  if (!window.ethereum) return false;

  try {
    await window.ethereum.request({
      method: 'wallet_requestSnaps',
      params: {
        'npm:@metamask/solana-wallet-snap': {},
      },
    });
    return true;
  } catch (error) {
    console.error('[solana] Failed to install Solana Snap:', error);
    return false;
  }
}

/**
 * Get SPL token balance for an address
 */
export async function getSolanaTokenBalance(
  ownerAddress: string,
  mintAddress: string
): Promise<bigint> {
  const conn = getSolanaConnection();
  const owner = new PublicKey(ownerAddress);
  const mint = new PublicKey(mintAddress);

  try {
    const tokenAccount = await getAssociatedTokenAddress(mint, owner);
    const balance = await conn.getTokenAccountBalance(tokenAccount);
    return BigInt(balance.value.amount);
  } catch (error) {
    // Account doesn't exist = 0 balance
    console.warn('[solana] Token account not found, assuming 0 balance');
    return 0n;
  }
}

/**
 * Sign a Solana transaction via MetaMask Snaps
 */
export async function signSolanaTransaction(
  transaction: Transaction
): Promise<Transaction> {
  if (!window.ethereum) throw new Error('MetaMask not found');

  const serializedTx = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  const result = await window.ethereum.request({
    method: 'wallet_invokeSnap',
    params: {
      snapId: 'npm:@metamask/solana-wallet-snap',
      request: {
        method: 'signTransaction',
        params: {
          transaction: Buffer.from(serializedTx).toString('base64'),
        },
      },
    },
  });

  // Deserialize the signed transaction
  return Transaction.from(Buffer.from(result.signedTransaction, 'base64'));
}

/**
 * Send a signed transaction to Solana
 */
export async function sendSolanaTransaction(
  signedTransaction: Transaction
): Promise<string> {
  const conn = getSolanaConnection();
  const signature = await conn.sendRawTransaction(signedTransaction.serialize());
  await conn.confirmTransaction(signature, 'confirmed');
  return signature;
}
```

### Step 15: Solana Shielding Functions

Create `src/lib/solana/shield.ts`:

```typescript
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import { getSolanaConnection, getSolanaAddress, signSolanaTransaction, sendSolanaTransaction } from './index';
import { getSolanaChain } from '../../config';

// IDL would be imported from generated types
// import { ClientShieldProxy } from '../../../solana/target/types/client_shield_proxy';

interface ShieldParams {
  amount: bigint;
  npk: Uint8Array;            // 32 bytes
  encryptedBundle: Uint8Array; // Variable length
  shieldKey: Uint8Array;       // 32 bytes
}

/**
 * Execute a shield from Solana to the Hub chain
 *
 * Flow:
 * 1. Build Anchor instruction for ClientShieldProxy.shield()
 * 2. Sign transaction via MetaMask Snap
 * 3. Submit to Solana
 * 4. Relayer picks up event and delivers to Hub
 */
export async function executeShieldFromSolana(
  params: ShieldParams
): Promise<{ signature: string }> {
  const solanaChain = getSolanaChain();
  if (!solanaChain) throw new Error('Solana chain not configured');

  const solanaAddress = await getSolanaAddress();
  if (!solanaAddress) throw new Error('No Solana address available');

  const connection = getSolanaConnection();
  const userPubkey = new PublicKey(solanaAddress);

  // Get program addresses from config
  const shieldProxyProgramId = new PublicKey(solanaChain.programs!.clientShieldProxy!);
  const usdcMint = new PublicKey(solanaChain.accounts!.usdcMint!);
  const shieldProxyConfig = new PublicKey(solanaChain.accounts!.shieldProxyConfig!);

  // Derive user's token account
  const userTokenAccount = await getAssociatedTokenAddress(usdcMint, userPubkey);

  // Derive vault PDA (program-owned token account)
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), usdcMint.toBuffer()],
    shieldProxyProgramId
  );

  // Build the shield instruction
  // Note: In practice, this would use the Anchor-generated client
  const instruction = buildShieldInstruction(
    shieldProxyProgramId,
    {
      config: shieldProxyConfig,
      userTokenAccount,
      vault: vaultPda,
      user: userPubkey,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
    {
      amount: new BN(params.amount.toString()),
      npk: Array.from(params.npk),
      encryptedBundle: Buffer.from(params.encryptedBundle),
      shieldKey: Array.from(params.shieldKey),
    }
  );

  // Build transaction
  const { blockhash } = await connection.getLatestBlockhash();
  const transaction = new Transaction({
    recentBlockhash: blockhash,
    feePayer: userPubkey,
  }).add(instruction);

  // Sign via MetaMask
  const signedTx = await signSolanaTransaction(transaction);

  // Send to network
  const signature = await sendSolanaTransaction(signedTx);

  console.log('[solana] Shield transaction sent:', signature);

  return { signature };
}

/**
 * Build the shield instruction
 * In practice, use Anchor's generated program client
 */
function buildShieldInstruction(
  programId: PublicKey,
  accounts: {
    config: PublicKey;
    userTokenAccount: PublicKey;
    vault: PublicKey;
    user: PublicKey;
    tokenProgram: PublicKey;
  },
  args: {
    amount: BN;
    npk: number[];
    encryptedBundle: Buffer;
    shieldKey: number[];
  }
): TransactionInstruction {
  // Anchor instruction discriminator for "shield"
  const discriminator = Buffer.from([/* 8-byte discriminator */]);

  // Serialize args (simplified - use Anchor's serialization in practice)
  const data = Buffer.concat([
    discriminator,
    args.amount.toArrayLike(Buffer, 'le', 8),
    Buffer.from(args.npk),
    // ... serialize encryptedBundle with length prefix
    Buffer.from(args.shieldKey),
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: accounts.config, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.user, isSigner: true, isWritable: false },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}
```

### Step 16: Update Shielded Wallet Hook

Update `src/hooks/useShieldedWallet.tsx` to include Solana address:

```typescript
import { getSolanaAddress, isSolanaSnapInstalled, installSolanaSnap } from '../lib/solana';

// Add to state interface
interface ShieldedWalletState {
  status: WalletStatus;
  railgunAddress: string | null;
  solanaAddress: string | null;        // NEW
  solanaSnapInstalled: boolean;        // NEW
  shieldedBalance: bigint;
  isScanning: boolean;
  error: string | null;
}

// Add to context interface
interface ShieldedWalletContextValue extends ShieldedWalletState {
  // ... existing fields ...
  installSolanaSnap: () => Promise<boolean>;  // NEW
  refreshSolanaAddress: () => Promise<void>;  // NEW
}

// In the provider, add Solana address fetching
export function ShieldedWalletProvider({ children }: ShieldedWalletProviderProps) {
  // ... existing code ...

  const [state, setState] = useState<ShieldedWalletState>({
    status: 'disconnected',
    railgunAddress: null,
    solanaAddress: null,           // NEW
    solanaSnapInstalled: false,    // NEW
    shieldedBalance: 0n,
    isScanning: false,
    error: null,
  });

  // Check for Solana Snap on mount
  useEffect(() => {
    const checkSnap = async () => {
      const installed = await isSolanaSnapInstalled();
      setState(prev => ({ ...prev, solanaSnapInstalled: installed }));

      if (installed) {
        const addr = await getSolanaAddress();
        setState(prev => ({ ...prev, solanaAddress: addr }));
      }
    };
    checkSnap();
  }, []);

  // Refresh Solana address
  const refreshSolanaAddress = useCallback(async () => {
    const addr = await getSolanaAddress();
    setState(prev => ({ ...prev, solanaAddress: addr }));
  }, []);

  // Install Solana Snap
  const handleInstallSolanaSnap = useCallback(async () => {
    const success = await installSolanaSnap();
    if (success) {
      setState(prev => ({ ...prev, solanaSnapInstalled: true }));
      await refreshSolanaAddress();
    }
    return success;
  }, [refreshSolanaAddress]);

  // ... rest of provider ...
}
```

### Step 17: Update Deposit Form

Update `src/components/deposit/DepositForm.tsx` to support Solana:

```typescript
import { isSolanaChain, getSolanaChain } from '../../config';
import { getSolanaTokenBalance } from '../../lib/solana';
import { executeShieldFromSolana } from '../../lib/solana/shield';
import { useShieldedWallet } from '../../hooks/useShieldedWallet';

export function DepositForm() {
  const {
    status,
    railgunAddress,
    solanaAddress,           // NEW
    solanaSnapInstalled,     // NEW
    installSolanaSnap,       // NEW
  } = useShieldedWallet();

  // ... existing state ...

  // Check if selected chain is Solana
  const selectedChain = allChains.find(c => c.id === selectedChainId);
  const isSolana = selectedChain?.chainType === 'solana';

  // Load balance based on chain type
  const loadBalanceAndAllowance = useCallback(async () => {
    if (!address || !selectedChain) return;

    setIsLoadingBalance(true);
    try {
      await loadDeployments();

      if (isSolanaChain(selectedChainId)) {
        // Solana balance
        if (!solanaAddress) {
          setBalance(0n);
          return;
        }
        const solanaChain = getSolanaChain();
        if (solanaChain?.accounts?.usdcMint) {
          const bal = await getSolanaTokenBalance(
            solanaAddress,
            solanaChain.accounts.usdcMint
          );
          setBalance(bal);
        }
        // No approval needed for Solana (handled differently)
        setAllowance(amount + 1n);  // Always "approved"
      } else {
        // EVM balance (existing code)
        const bal = await getPublicBalance(selectedChain, address);
        setBalance(bal);
        // ... existing allowance check ...
      }
    } catch (err) {
      console.error('Failed to load balance:', err);
    } finally {
      setIsLoadingBalance(false);
    }
  }, [address, selectedChain, selectedChainId, solanaAddress]);

  // Handle shield - branch on chain type
  const handleShield = async () => {
    // ... existing validation ...

    if (isSolanaChain(selectedChainId)) {
      await handleSolanaShield();
    } else {
      await handleEvmShield();
    }
  };

  // NEW: Solana shield handler
  const handleSolanaShield = async () => {
    if (!solanaAddress || !railgunAddress) return;

    setStep('init');
    setError(null);
    setTxHash(null);

    try {
      // Get shield private key (same as EVM - signs with MetaMask EVM account)
      const shieldPrivateKey = await getShieldPrivateKey();

      const tokenAddress = getSolanaChain()?.accounts?.usdcMint;
      if (!tokenAddress) throw new Error('No USDC mint address');

      setStep('shielding');

      // Create shield request using Railgun SDK (same as EVM)
      const shieldRequest = await createShieldRequest(
        railgunAddress,
        amount,
        tokenAddress,
        shieldPrivateKey
      );

      // Execute Solana shield
      const result = await executeShieldFromSolana({
        amount,
        npk: shieldRequest.npk,
        encryptedBundle: shieldRequest.encryptedBundle,
        shieldKey: shieldRequest.shieldKey,
      });

      setTxHash(result.signature);
      setStep('success');
      setAmountInput('');

      await loadBalanceAndAllowance();
    } catch (err) {
      console.error('Solana shield error:', err);
      setError(err instanceof Error ? err.message : 'Shield failed');
      setStep('error');
    }
  };

  // Existing EVM shield handler (renamed)
  const handleEvmShield = async () => {
    // ... existing EVM shield code ...
  };

  return (
    <div className="p-6 bg-gray-900 rounded-xl border border-gray-800">
      {/* ... existing JSX ... */}

      {/* NEW: Solana Snap notice */}
      {isSolana && !solanaSnapInstalled && (
        <div className="p-3 bg-yellow-900/30 border border-yellow-700/50 rounded-lg mb-4">
          <p className="text-yellow-400 text-sm">
            MetaMask Solana Snap required for Solana transactions.
          </p>
          <button
            onClick={installSolanaSnap}
            className="mt-2 px-3 py-1 bg-yellow-600 hover:bg-yellow-500 rounded text-sm"
          >
            Install Solana Snap
          </button>
        </div>
      )}

      {/* NEW: Show Solana address when Solana chain selected */}
      {isSolana && solanaAddress && (
        <div className="text-xs text-gray-500 mb-2">
          Solana address: {solanaAddress.slice(0, 8)}...{solanaAddress.slice(-6)}
        </div>
      )}

      {/* ... rest of form ... */}
    </div>
  );
}
```

### Step 18: Update Pay Form (Unshield to Solana)

Update `src/components/pay/PayForm.tsx`:

```typescript
import { isSolanaChain, getSolanaChain } from '../../config';
import { useShieldedWallet } from '../../hooks/useShieldedWallet';

export function PayForm() {
  const {
    solanaAddress,
    solanaSnapInstalled,
  } = useShieldedWallet();

  // ... existing code ...

  // NEW: Detect Solana address format
  function detectRecipientType(address: string): RecipientType {
    if (!address) return 'unknown';

    if (address.startsWith('0zk')) {
      return address.length > 10 ? 'railgun' : 'unknown';
    }

    if (address.startsWith('0x')) {
      return address.length === 42 ? 'ethereum' : 'unknown';
    }

    // NEW: Check for Solana address (base58, 32-44 chars typically)
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      return 'solana';
    }

    return 'unknown';
  }

  // Update type
  type RecipientType = 'unknown' | 'railgun' | 'ethereum' | 'solana';

  // Get all chains including Solana
  const solanaChain = getSolanaChain();
  const allChains = [hubChain, ...clientChains, ...(solanaChain ? [solanaChain] : [])];

  // In handleSend, add Solana destination handling
  const handleSend = async () => {
    // ... existing code ...

    if (isHubDestination) {
      setTxHash(unshieldResult.txHash);
      setStep('success');
    } else if (isSolanaChain(destinationChainId)) {
      // NEW: Bridge to Solana
      setStep('bridging');

      // For Solana destination, we still use the Hub's bridging mechanism
      // The relayer handles the Solana-side minting
      const bridgeResult = await bridgeToSolana(
        hubConfig,
        signer,
        amount,
        recipientInput,  // Solana address
      );

      setTxHash(bridgeResult.txHash);
      setStep('success');
    } else {
      // Existing EVM bridge code
      setStep('bridging');
      const bridgeResult = await bridgeToClientChain(/* ... */);
      setTxHash(bridgeResult.txHash);
      setStep('success');
    }
  };

  // NEW: Use own Solana address as default for Solana destination
  useEffect(() => {
    if (destinationChainId && isSolanaChain(destinationChainId) && solanaAddress && !recipientInput) {
      setRecipientInput(solanaAddress);
    }
  }, [destinationChainId, solanaAddress, recipientInput]);

  return (
    <div>
      {/* ... existing JSX ... */}

      {/* NEW: Recipient type indicator for Solana */}
      {recipientType === 'solana' && (
        <p className="text-xs mt-1 text-orange-400">
          Unshield to Solana address
        </p>
      )}

      {/* NEW: Solana destination notice */}
      {isSolanaChain(destinationChainId) && (
        <p className="text-xs text-orange-500 mt-1">
          Cross-VM transfer to Solana (via relayer)
        </p>
      )}
    </div>
  );
}
```

### Step 19: Add Solana Bridge Function

Add to `src/lib/sdk.ts`:

```typescript
import { isSolanaChain } from '../config';

/**
 * Bridge USDC from Hub to Solana
 * Calls HubUnshieldProxy with Solana destination
 */
export async function bridgeToSolana(
  hubChain: ChainConfig,
  signer: Signer,
  amount: bigint,
  solanaRecipient: string,  // Base58 Solana address
): Promise<{ txHash: string }> {
  const hubUnshieldProxy = hubChain.contracts?.hubUnshieldProxy;
  if (!hubUnshieldProxy) throw new Error('HubUnshieldProxy not deployed');

  const contract = new ethers.Contract(
    hubUnshieldProxy,
    [
      'function bridgeToSolana(uint256 amount, bytes32 recipient) external',
    ],
    signer
  );

  // Convert Solana address to bytes32
  // Solana addresses are already 32 bytes when decoded from base58
  const recipientBytes32 = solanaAddressToBytes32(solanaRecipient);

  const tx = await contract.bridgeToSolana(amount, recipientBytes32);
  const receipt = await tx.wait();

  return { txHash: receipt.hash };
}

/**
 * Convert Solana base58 address to bytes32
 */
function solanaAddressToBytes32(address: string): string {
  const { PublicKey } = require('@solana/web3.js');
  const pubkey = new PublicKey(address);
  return '0x' + Buffer.from(pubkey.toBytes()).toString('hex');
}
```

### Step 20: Solana Address Validation

Create `src/lib/solana/address.ts`:

```typescript
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Validate a Solana address
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert Solana address to 32-byte array
 */
export function solanaAddressToBytes(address: string): Uint8Array {
  return new PublicKey(address).toBytes();
}

/**
 * Convert 32-byte array to Solana address
 */
export function bytesToSolanaAddress(bytes: Uint8Array): string {
  return new PublicKey(bytes).toBase58();
}

/**
 * Convert Solana address to hex bytes32 (for EVM contracts)
 */
export function solanaAddressToBytes32Hex(address: string): string {
  const bytes = solanaAddressToBytes(address);
  return '0x' + Buffer.from(bytes).toString('hex');
}

/**
 * Shorten Solana address for display
 */
export function shortenSolanaAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
```

### Frontend File Summary

| File | Changes |
|------|---------|
| `package.json` | Add @solana/web3.js, @coral-xyz/anchor, bs58 |
| `src/config/chains.json` | Add Solana chain with chainType field |
| `src/config/index.ts` | Add Solana helpers, load Solana deployments |
| `src/lib/solana/index.ts` | NEW: Solana connection, MetaMask Snap integration |
| `src/lib/solana/shield.ts` | NEW: Solana shielding functions |
| `src/lib/solana/address.ts` | NEW: Solana address utilities |
| `src/lib/sdk.ts` | Add bridgeToSolana function |
| `src/hooks/useShieldedWallet.tsx` | Add solanaAddress, Snap management |
| `src/components/deposit/DepositForm.tsx` | Add Solana chain support, Snap install flow |
| `src/components/pay/PayForm.tsx` | Add Solana destination support |

### Key Design Decisions

1. **MetaMask-Only**: Uses MetaMask Snaps for Solana, avoiding separate wallet adapters
2. **Same Railgun Keys**: Key derivation unchanged (EVM signature), unified identity
3. **Chain Type Discrimination**: `chainType: 'evm' | 'solana'` enables branching
4. **Relayer-Based Bridging**: Cross-VM transfers still go through Hub + relayer
5. **No Solana-Side Proof Generation**: All ZK proofs happen on Hub (EVM)

### Testing the Frontend

1. Install MetaMask Flask (or wait for Snaps to be in stable MetaMask)
2. Install the Solana Snap when prompted
3. Ensure Solana test validator is running with programs deployed
4. Test shield from Solana:
   - Select "Solana" in chain dropdown
   - Enter amount
   - Confirm transaction in MetaMask
5. Test unshield to Solana:
   - Enter Solana address as recipient
   - Select Solana as destination chain
   - Complete unshield + bridge flow

## Future Considerations

1. **Real CCTP Integration**: When moving to testnet/mainnet, replace mock programs with actual Circle CCTP on Solana
2. **Wormhole Alternative**: Could use Wormhole instead of CCTP for Solana bridging
3. **Token-2022**: Consider using Solana's Token-2022 for additional features
4. **Compression**: Solana state compression could reduce costs for high-volume scenarios
5. **Native Solana Wallet Support**: Add Phantom/Solflare support for users without MetaMask
