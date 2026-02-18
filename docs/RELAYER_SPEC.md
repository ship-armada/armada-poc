# Armada Relayer — Specification

## Overview

The Armada Relayer is a unified service that handles two core functions:

1. **CCTP Relay**: Monitor for cross-chain `MessageSent` events, fetch attestations, and call `receiveMessage` on the destination chain.
2. **Privacy Relay**: Accept shielded transaction requests from users, validate fees, and submit transactions on their behalf — so the user's Ethereum address never appears on-chain for privacy-preserving operations.

The relayer eliminates the need for users to hold native tokens (ETH). Users only need USDC — relayer fees are paid from within the shielded transaction or deducted from shield amounts.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       Armada Relayer                          │
│                                                              │
│  ┌───────────────┐  ┌────────────────┐  ┌─────────────────┐ │
│  │  CCTP Module   │  │ Privacy Relay   │  │  Fee Broadcast  │ │
│  │               │  │ Module          │  │  Module         │ │
│  │ Poll chains   │  │ Accept requests │  │ Calculate fees  │ │
│  │ Fetch attests │  │ Validate fees   │  │ Advertise to    │ │
│  │ Submit rx     │  │ Submit tx       │  │ clients         │ │
│  └───────┬───────┘  └───────┬────────┘  └────────┬────────┘ │
│          │                  │                     │          │
│  ┌───────▼──────────────────▼─────────────────────▼────────┐ │
│  │                   Wallet Manager                         │ │
│  │   Nonce tracking · Gas estimation · Wallet pool          │ │
│  └──────────────────────────┬───────────────────────────────┘ │
│                             │                                │
│  ┌──────────────────────────▼───────────────────────────────┐ │
│  │                   Chain Connections                       │ │
│  │   Hub + Client A + Client B (extensible)                  │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Operations by Submission Method

### Relayer-submitted (privacy-preserving)

| Operation | Fee mechanism | Why relayer is needed |
|-----------|--------------|---------------------|
| **Transfer** (private → private) | Fee from shielded USDC output (SDK built-in) | Hide sender's Ethereum address |
| **Unshield** (private → public) | Fee from shielded USDC output (SDK built-in) | Hide sender's Ethereum address; prevent linking to unshield recipient |
| **Shielded lend/redeem** (via ArmadaYieldAdapter) | Fee from shielded USDC output (SDK built-in) | Hide sender's Ethereum address |
| **Cross-chain shield** (hub-side execution) | Fee deducted from shield amount on-chain (Option A) | User can't pay gas on hub chain; relayer executes `receiveMessage` |

### Trust Model: Shielded Yield (lendAndShield / redeemAndShield)

Shielded lend and redeem are **trustless** with respect to the adapter and relayer:

- **ArmadaYieldAdapter** cannot deviate from the user's proof. The proof binds `adaptParams = hash(npk, encryptedBundle, shieldKey)`. The adapter verifies that the provided shield parameters match before executing. If they don't match, the transaction reverts. The adapter MUST shield to the user's committed destination.
- **Relayer** pays gas and may charge a fee (included in the proof). The relayer cannot steal funds — the proof commits to all outputs. The relayer simply submits the transaction on behalf of the user.

### User-submitted (no privacy concern)

| Operation | Notes |
|-----------|-------|
| **Local shield** (public → private on same chain) | User is already revealing their address by depositing |
| **USDC approve** (one-time per chain) | Required before first shield |

## Fee Model

### Transfers, Unshields, Cross-Contract Calls

The Railgun SDK natively supports a relayer fee field in proof generation. The proof commits to paying X USDC to the relayer as part of the unshield/output step. The fee is atomic with the transaction — the relayer cannot extract more than the committed amount, and the user cannot pay less.

```
Fee calculation:
  gasEstimate   = estimateGas(relay() or transact() call)
  gasPrice      = current gas price on hub chain
  gasCostWei    = gasEstimate × gasPrice
  gasCostUSDC   = gasCostWei × (ethPrice / usdcPrice)
  relayerFee    = gasCostUSDC × (1 + profitMargin)
```

- Locally: ETH/USDC price is hardcoded (e.g., 1 ETH = 2000 USDC)
- Testnet/production: Price feed from oracle or configurable ratio

### Cross-Chain Shields (Option A)

For cross-chain shields, the user cannot include a relayer fee in a proof (there is no proof for shields). Instead, the fee is deducted from the shielded amount on the hub chain:

1. User calls `shieldCrossChain(amount, relayerFee, ...)` on client chain
2. CCTP burns `amount` USDC and encodes `relayerFee` in the message body
3. Relayer calls `receiveMessage()` on hub chain
4. Hub-side `ShieldModule` creates commitment for `amount - relayerFee` and transfers `relayerFee` to the relayer address

The relayer only processes the CCTP message if the encoded `relayerFee` meets its minimum threshold.

Contract changes required:
- `PrivacyPoolClient.shieldCrossChain()`: Accept `relayerFee` parameter, encode in CCTP message body
- `ShieldModule.processCrossChainShield()`: Parse `relayerFee` from message body, deduct from commitment amount, transfer fee to `msg.sender` (the relayer)

### Fee Broadcast

The relayer periodically advertises its current fee schedule so clients can include the correct fee in their proofs.

```
Fee schedule:
{
  cacheId: "fee-1706...",          // Unique ID, used for validation
  expiresAt: 1706...,             // TTL (e.g., 5 minutes)
  chainId: 31337,
  fees: {
    transfer:      "0.05",        // USDC per transfer
    unshield:      "0.05",        // USDC per unshield
    crossContract: "0.08",        // USDC per relay() call (higher gas)
    crossChainShield: "0.03",     // USDC deducted from shield amount
  }
}
```

## API

### HTTP Endpoints (local and testnet)

```
GET  /fees
  → { cacheId, expiresAt, chainId, fees }

POST /relay
  ← { chainId, to, data, feesCacheId }
  → { txHash, status: "pending" }

GET  /status/:txHash
  → { status: "pending" | "confirmed" | "failed", blockNumber?, error? }
```

### Production Transport (future)

In production, the HTTP API would be replaced or supplemented by Waku P2P messaging (following the ppoi-safe-broadcaster pattern):
- Fee broadcast: Relayer publishes encrypted fee messages to chain-specific Waku topics
- Transaction requests: Client publishes encrypted transaction request to relayer's topic
- Responses: Relayer publishes encrypted tx hash back to client's topic

The HTTP API can remain as a fallback or for direct relayer integrations.

## Request/Response Flow

### Privacy Relay (transfers, unshields, cross-contract calls)

```
User (browser)                           Relayer
     │                                       │
     │  1. GET /fees                         │
     │ ─────────────────────────────────────→ │
     │  { cacheId, fees }                    │
     │ ←───────────────────────────────────── │
     │                                       │
     │  2. Generate proof in browser          │
     │     (includes relayer fee in outputs)  │
     │     (~20-30 seconds)                  │
     │                                       │
     │  3. POST /relay                       │
     │  { chainId, to, data, feesCacheId }   │
     │ ─────────────────────────────────────→ │
     │                                       │
     │  4. Validate:                         │
     │     - Fee matches advertised rate     │
     │     - Gas estimate within bounds      │
     │     - Transaction well-formed         │
     │                                       │
     │  5. Submit tx from relayer wallet     │
     │                                       │
     │  6. { txHash, status: "pending" }     │
     │ ←───────────────────────────────────── │
     │                                       │
     │  7. Poll GET /status/:txHash          │
     │ ─────────────────────────────────────→ │
     │  { status: "confirmed", block: 42 }   │
     │ ←───────────────────────────────────── │
```

### Cross-Chain Shield

```
User (client chain)                      Relayer                        Hub Chain
     │                                       │                              │
     │  1. GET /fees (shield fee)            │                              │
     │ ─────────────────────────────────────→ │                              │
     │  { crossChainShield: "0.03" }         │                              │
     │ ←───────────────────────────────────── │                              │
     │                                       │                              │
     │  2. shieldCrossChain(amount,          │                              │
     │     relayerFee, ...) on client chain  │                              │
     │     → Burns USDC via CCTP             │                              │
     │     → Encodes relayerFee in message   │                              │
     │ ──────── tx on client chain ─────────→ │                              │
     │                                       │                              │
     │                                       │  3. Detect MessageSent event │
     │                                       │  4. Parse relayerFee from    │
     │                                       │     message body             │
     │                                       │  5. Verify fee >= minimum    │
     │                                       │  6. Fetch attestation        │
     │                                       │     (stub locally,           │
     │                                       │      Circle API on testnet)  │
     │                                       │                              │
     │                                       │  7. receiveMessage() ───────→│
     │                                       │     → Mint USDC              │
     │                                       │     → Create commitment for  │
     │                                       │       (amount - relayerFee)  │
     │                                       │     → Transfer relayerFee    │
     │                                       │       to msg.sender (relayer)│
     │                                       │                              │
     │                                       │  8. Confirm receipt          │
```

## Modules

### 1. CCTP Module

Extends the existing POC relayer with:

- **Retry queue**: Failed relays are requeued with exponential backoff (max 5 retries)
- **Message state machine**: `Created → Pending → Attested → Complete | Failed`
- **Attestation fetching**: Stub locally (auto-approve), Circle API on testnet
- **Deduplication**: Check on-chain `UsedNonces` before attempting relay
- **Fee validation**: Parse `relayerFee` from cross-chain shield messages, skip if below minimum

Reference: noble-cctp-relayer's WebSocket + worker pool pattern

### 2. Privacy Relay Module

Accepts shielded transaction requests and submits them on behalf of users.

- **Request validation**:
  - Decode transaction data to verify it targets expected contracts (PrivacyPool, ArmadaYieldAdapter)
  - Verify `feesCacheId` matches a recently advertised fee schedule (within TTL)
  - Estimate gas and verify fee covers cost + margin
  - Reject if transaction data is malformed or targets unexpected contracts
- **Submission**: Call the target contract from the relayer's wallet
- **Confirmation**: Wait for receipt, return tx hash and status
- **Error handling**: On revert, return error details to client; do not retry automatically (user must re-generate proof)

Reference: ppoi-safe-broadcaster's transaction validation and execution pattern

### 3. Fee Broadcast Module

Calculates and advertises current fee schedule.

- **Fee calculation**:
  ```
  gasEstimate per operation type (cached, refreshed every 60s)
  × current gas price
  × ETH/USDC price ratio
  × (1 + profitMargin)
  = fee in USDC
  ```
- **Broadcast**: HTTP endpoint locally; Waku P2P in production
- **Fee cache**: Each fee schedule has a `cacheId` and TTL (default 5 minutes)
- **Validation**: When a relay request arrives, verify the included `feesCacheId` is still valid and fee amount matches

Reference: ppoi-safe-broadcaster's `getAllUnitTokenFeesForChain()` and fee broadcast pattern

### 4. Wallet Manager

Manages relayer hot wallets for transaction submission.

- **Wallet pool**: Single wallet locally; multiple wallets in production for throughput
- **Nonce tracking**:
  - Initialize from on-chain pending nonce at startup
  - Increment optimistically after submission
  - Reset on nonce-related errors
  - Persist last-used nonce to survive restarts
- **Wallet locking**: Mark wallet unavailable during pending transaction; unlock on confirmation or timeout
- **Gas balance monitoring**: Warn if ETH balance drops below threshold
- **Transaction deduplication**: Hash-based cache (10-minute TTL) to prevent duplicate submissions

Reference: ppoi-safe-broadcaster's `ActiveWallet` and nonce management; noble-cctp-relayer's `SequenceMap`

## Contract Changes Required

### PrivacyPoolClient.sol

Add `relayerFee` parameter to `shieldCrossChain()`:

```solidity
function shieldCrossChain(
    uint256 amount,
    uint256 relayerFee,    // NEW: fee for hub-side execution
    bytes32 npk,
    ShieldCiphertext calldata ciphertext
) external {
    require(relayerFee < amount, "fee exceeds amount");
    // Encode relayerFee in CCTP message body alongside shield data
    // Burn full amount via CCTP (fee is deducted on hub side)
}
```

### ShieldModule.sol

Parse and deduct relayer fee on cross-chain shield:

```solidity
function _processCrossChainShield(
    bytes calldata messageBody
) internal {
    // Decode: amount, relayerFee, npk, ciphertext from messageBody
    uint256 commitmentAmount = amount - relayerFee;

    // Create shielded commitment for commitmentAmount
    // Transfer relayerFee to msg.sender (the relayer)
    if (relayerFee > 0) {
        token.safeTransfer(msg.sender, relayerFee);
    }
}
```

## Frontend Changes

### Current flow (user submits directly)

```typescript
// shieldedYieldService.ts
const tx = await signer.sendTransaction(populatedTx)
const receipt = await tx.wait(1)
```

### New flow (relayer submits)

```typescript
// relayerClient.ts
async function submitViaRelayer(populatedTx: PopulatedTransaction): Promise<string> {
  // 1. Get current fees
  const fees = await fetch(`${RELAYER_URL}/fees`).then(r => r.json())

  // 2. Submit to relayer
  const { txHash } = await fetch(`${RELAYER_URL}/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId: populatedTx.chainId,
      to: populatedTx.to,
      data: populatedTx.data,
      feesCacheId: fees.cacheId,
    }),
  }).then(r => r.json())

  // 3. Poll for confirmation
  return pollForConfirmation(txHash)
}

async function pollForConfirmation(txHash: string): Promise<string> {
  while (true) {
    const { status, error } = await fetch(
      `${RELAYER_URL}/status/${txHash}`
    ).then(r => r.json())

    if (status === 'confirmed') return txHash
    if (status === 'failed') throw new Error(error)
    await new Promise(r => setTimeout(r, 2000))
  }
}
```

The SDK proof generation calls need to include the relayer fee in their parameters:

```typescript
// When generating proof, include relayer fee
const relayerFee = await getRelayerFee('crossContract')
const proof = await generateCrossContractCallsProof({
  // ... existing params
  relayerFeeERC20AmountRecipients: [{
    tokenAddress: USDC_ADDRESS,
    amount: relayerFee,
    recipientAddress: RELAYER_ADDRESS,
  }],
})
```

## What Can Be Built Locally vs. Testnet

### Build locally (the bulk of the work)

| Component | Notes |
|-----------|-------|
| HTTP API server (`/fees`, `/relay`, `/status`) | Same API surface on testnet |
| Fee calculation engine | Hardcode ETH/USDC price locally |
| Fee validation on relay requests | Verify fee in proof matches advertised rate |
| Wallet manager with nonce tracking | Works identically on local and testnet |
| Transaction submission + confirmation | Same ethers.js calls, different RPC |
| Retry queue with state machine | Full implementation, same logic everywhere |
| CCTP relay with retry/dedup | Extend existing POC relayer |
| Frontend integration | Major change — replace MetaMask signing with relayer API |
| Transaction deduplication | Hash-based cache, same everywhere |
| Cross-chain shield fee deduction | Contract changes + message encoding |

### Must wait for testnet

| Component | Why |
|-----------|-----|
| Circle attestation API | Local CCTP has no attestation step — we auto-approve. Real attestations only on testnet |
| Waku P2P transport | Requires network peers; HTTP is functionally equivalent |
| Real gas price volatility | Anvil has static gas pricing. Testnet has real fee market |
| Multi-relayer competition | Need multiple instances to test race conditions |
| ETH/USDC price oracle | Chainlink not on local chains. Hardcode ratio locally |
| Production wallet security | HSM, key rotation, etc. — not relevant for local dev |

## Error Handling

### Transaction Reverts

If a relayed transaction reverts:
- Relayer returns error details to client via `/status` endpoint
- For privacy operations: nullifiers are rolled back (EVM atomicity), user funds are safe
- User must re-generate proof and resubmit (proofs are single-use)
- Relayer does NOT retry automatically — the proof may be stale

### Fee Staleness

If gas price changes between fee broadcast and relay submission:
- Relayer validates fee with a tolerance buffer (e.g., 20% variance)
- If fee is too low after buffer, relay is rejected with `FEE_TOO_LOW` error
- Client should re-fetch fees and re-generate proof

### Nonce Conflicts

If two relay requests arrive simultaneously:
- Wallet manager serializes submissions per wallet
- Second request waits for first to confirm or timeout
- With multiple wallets: requests are distributed across available wallets

## Configuration

```typescript
interface RelayerConfig {
  // Chain connections
  chains: {
    hub: { rpc: string, chainId: number }
    clients: Array<{ rpc: string, chainId: number, domain: number }>
  }

  // Wallet
  privateKeys: string[]           // Hot wallet keys (1 for local, N for production)

  // Fees
  profitMarginBps: number         // e.g., 1000 = 10% markup over gas cost
  ethUsdcPrice: number            // Hardcoded locally (e.g., 2000)
  feeTtlSeconds: number           // How long a fee quote is valid (e.g., 300)
  feeVarianceBufferBps: number    // Tolerance for gas price changes (e.g., 2000 = 20%)

  // CCTP
  attestationApiUrl: string       // Circle's API (stub locally)
  attestationPollIntervalMs: number

  // Retry
  maxRetries: number              // Max retry attempts for CCTP relay
  retryBackoffMs: number          // Base backoff interval

  // Contracts
  privacyPool: string
  relayAdapt: string
  messageTransmitter: string

  // Server
  port: number                    // HTTP API port (e.g., 3001)
}
```

## Reference Implementations

- **CCTP relay patterns**: `noble-cctp-relayer` — WebSocket streaming, worker pool, attestation polling, message state machine
- **Privacy relay patterns**: `ppoi-safe-broadcaster-example` — Waku P2P transport, fee calculation/broadcast, nonce management, transaction validation, wallet pool
- **Current POC relayer**: `poc/relayer/` — Basic polling-based CCTP relay with nonce management
