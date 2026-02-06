# Armada Relayer — Implementation Plan (Local POC)

This document breaks the relayer spec into actionable implementation phases. Each phase produces a working, testable increment.

Reference: [RELAYER_SPEC.md](./RELAYER_SPEC.md)

---

## Phase 1: HTTP API Server + Wallet Manager

**Goal**: Stand up the relayer HTTP server with fee calculation and transaction submission for hub-chain privacy operations (transfers, unshields). The CCTP relay continues working as-is alongside.

### 1.1 Project Structure

Create the new relayer as a separate entry point alongside the existing `relay-v2.ts`:

```
relayer/
├── relay-v2.ts              # Existing CCTP relay (keep as-is initially)
├── armada-relayer.ts         # New entry point - starts all modules
├── config.ts                 # Existing config (extend with relayer settings)
├── modules/
│   ├── http-api.ts           # Express server: /fees, /relay, /status
│   ├── fee-calculator.ts     # Fee calculation engine
│   ├── wallet-manager.ts     # Nonce tracking, tx submission, wallet locking
│   ├── privacy-relay.ts      # Validate + submit privacy transactions
│   └── cctp-relay.ts         # Extracted from relay-v2.ts (Phase 3)
└── types.ts                  # Shared types
```

### 1.2 Config Extension

Extend `relayer/config.ts` with:

```typescript
export interface RelayerConfig {
  port: number                     // HTTP API port (3001)
  profitMarginBps: number          // Fee markup (1000 = 10%)
  ethUsdcPrice: number             // Hardcoded locally (2000)
  feeTtlSeconds: number            // Fee quote validity (300)
  feeVarianceBufferBps: number     // Gas price tolerance (2000 = 20%)
  privacyPool: string              // From deployment JSON
  relayAdapt: string               // From deployment JSON
}
```

Load contract addresses from existing deployment JSONs (`privacy-pool-hub.json`, `hub-v3.json`).

### 1.3 Wallet Manager (`modules/wallet-manager.ts`)

Manages the relayer's hot wallet for submitting transactions:

- **Initialize**: Read deployer private key from config, connect to hub provider
- **Nonce tracking**: Fetch pending nonce from chain at startup; increment optimistically after each submission; reset on nonce errors
- **Wallet locking**: Simple mutex — reject concurrent submissions (single wallet for POC)
- **`submitTransaction(to, data, gasLimit?)`**: Signs and submits; returns tx hash; waits for receipt
- **Gas balance check**: Log warning if ETH balance < 0.1 ETH

Key implementation detail: The wallet manager uses the same deployer account that currently signs CCTP relays. This is fine for local POC since Anvil pre-funds it with 10000 ETH.

### 1.4 Fee Calculator (`modules/fee-calculator.ts`)

Calculates fees in USDC for each operation type:

```
fee = gasEstimate × gasPrice × (ethPrice / usdcPrice) × (1 + profitMargin)
```

For local POC:
- `gasEstimate`: Hardcoded per operation type (transfer: 500k, unshield: 500k, crossContract: 2M, crossChainShield: 500k)
- `gasPrice`: Fetched from hub provider (`provider.getFeeData()`)
- `ethPrice`: Hardcoded 2000 USDC/ETH
- `profitMargin`: 10% (1000 bps)

Outputs:
- **Fee schedule**: Object with cacheId (uuid), expiresAt (Date.now() + TTL), and per-operation fees in USDC raw units
- **Validation**: Given a cacheId and fee amount, verify the quote is still valid and fee is sufficient (within variance buffer)

### 1.5 HTTP API (`modules/http-api.ts`)

Express server on port 3001:

**`GET /fees`**
- Returns current fee schedule from fee calculator
- Response: `{ cacheId, expiresAt, chainId, fees: { transfer, unshield, crossContract, crossChainShield } }`

**`POST /relay`**
- Accepts: `{ chainId, to, data, feesCacheId }`
- Validates request (see Privacy Relay module)
- Submits via wallet manager
- Returns: `{ txHash, status: "pending" }`

**`GET /status/:txHash`**
- Checks transaction receipt on-chain
- Returns: `{ status: "pending"|"confirmed"|"failed", blockNumber?, error? }`
- Implementation: Simple on-chain lookup via `provider.getTransactionReceipt(txHash)`

### 1.6 Privacy Relay (`modules/privacy-relay.ts`)

Validates and routes incoming relay requests:

**Validation checklist**:
1. `chainId` matches hub chain (31337)
2. `to` address is either PrivacyPool or RelayAdapt (from deployment config)
3. `feesCacheId` matches a valid, non-expired fee quote
4. `data` is non-empty and decodes to a recognized function selector:
   - `transact()` on PrivacyPool (transfers, unshields)
   - `relay()` on RelayAdapt (cross-contract calls)
5. Gas estimate (via `provider.estimateGas()`) is within expected bounds

**Submission**:
- Call `walletManager.submitTransaction(to, data)`
- Return txHash immediately
- Receipt polling is handled by the `/status` endpoint

### 1.7 Testing Phase 1

Manual testing flow:
1. Start Anvil chains + deploy contracts (`npm run chains && npm run setup`)
2. Start armada relayer (`npm run armada-relayer`)
3. Use curl to test endpoints:
   ```bash
   # Get fees
   curl http://localhost:3001/fees

   # Submit a pre-signed transaction (use hardhat to generate calldata)
   curl -X POST http://localhost:3001/relay \
     -H 'Content-Type: application/json' \
     -d '{"chainId":31337,"to":"0x...","data":"0x...","feesCacheId":"..."}'

   # Check status
   curl http://localhost:3001/status/0x...
   ```

Add npm script: `"armada-relayer": "ts-node relayer/armada-relayer.ts"`

### Files to create/modify:
| File | Action |
|------|--------|
| `relayer/armada-relayer.ts` | Create — entry point |
| `relayer/modules/http-api.ts` | Create — Express server |
| `relayer/modules/fee-calculator.ts` | Create — fee engine |
| `relayer/modules/wallet-manager.ts` | Create — tx submission |
| `relayer/modules/privacy-relay.ts` | Create — validation + routing |
| `relayer/types.ts` | Create — shared interfaces |
| `relayer/config.ts` | Modify — add RelayerConfig |
| `package.json` | Modify — add express dep, armada-relayer script |

### Dependencies to add:
- `express` + `@types/express` (HTTP server)
- `uuid` + `@types/uuid` (fee cache IDs)
- `cors` + `@types/cors` (frontend CORS)

---

## Phase 2: Frontend Integration (Relayer Submission)

**Goal**: Frontend submits privacy transactions (transfers, unshields, cross-contract calls) via the relayer HTTP API instead of MetaMask. Users no longer need ETH for these operations.

### 2.1 Relayer Client (`usdc-v2-frontend/src/services/relayer/relayerClient.ts`)

Create a client module that wraps relayer HTTP calls:

```typescript
interface RelayerClient {
  getFees(): Promise<FeeSchedule>
  submitTransaction(params: RelayRequest): Promise<{ txHash: string }>
  waitForConfirmation(txHash: string): Promise<TransactionStatus>
}
```

**`getFees()`**: Fetch and cache fee schedule. Re-fetch when expired.

**`submitTransaction()`**: POST to `/relay` with populated transaction data.

**`waitForConfirmation()`**: Poll `/status/:txHash` every 2 seconds until confirmed or failed. Timeout after 60 seconds.

### 2.2 SDK Integration Changes

The Railgun SDK proof generation functions accept a `broadcasterFeeERC20AmountRecipient` parameter that is currently set to `undefined`. This is the native mechanism for including relayer fees in proofs.

**Changes to proof generation calls**:

In `sdk.ts` — `executePrivateTransfer()`:
```typescript
// Before:
await generateTransferProof(
  ...
  undefined, // broadcasterFeeERC20AmountRecipient
  true,      // sendWithPublicWallet
  ...
)

// After:
const relayerFee = await relayerClient.getFees()
await generateTransferProof(
  ...
  {
    tokenAddress: USDC_ADDRESS,
    amount: BigInt(relayerFee.fees.transfer),
    recipientAddress: RELAYER_ETH_ADDRESS,
  },
  false,     // sendWithPublicWallet = false (relayer submits)
  ...
)
```

Same pattern for `executeUnshield()` and `generateCrossContractCallsProof()` in `shieldedYieldService.ts`.

**Transaction submission changes**:

Replace MetaMask `signer.sendTransaction()` with `relayerClient.submitTransaction()`:

```typescript
// Before (sdk.ts, shieldedYieldService.ts):
const provider = new ethers.BrowserProvider(window.ethereum)
const signer = await provider.getSigner()
const tx = await signer.sendTransaction(txRequest)
const receipt = await tx.wait()

// After:
const { txHash } = await relayerClient.submitTransaction({
  chainId: 31337,
  to: populateResult.transaction.to,
  data: populateResult.transaction.data,
  feesCacheId: fees.cacheId,
})
const status = await relayerClient.waitForConfirmation(txHash)
```

### 2.3 Dual-Mode Support

Keep MetaMask submission as fallback. Add a config flag:

```typescript
// config/relayer.ts
export const RELAYER_CONFIG = {
  enabled: true,
  url: 'http://localhost:3001',
  // If false, falls back to MetaMask submission
}
```

Create a unified `submitTransaction()` function that checks config:

```typescript
async function submitTransaction(populatedTx, feesCacheId?) {
  if (RELAYER_CONFIG.enabled) {
    return relayerClient.submitTransaction({ ...populatedTx, feesCacheId })
  } else {
    // Existing MetaMask path
    const signer = await getSigner()
    return signer.sendTransaction(populatedTx)
  }
}
```

### 2.4 UX Changes

When using relayer mode:
- Remove "Sign transaction" prompt (no MetaMask popup)
- Replace with "Submitting to relayer..." stage
- Show "Waiting for confirmation..." while polling status
- Display relayer fee in transaction summary before proof generation

### 2.5 Files to create/modify:

| File | Action |
|------|--------|
| `usdc-v2-frontend/src/services/relayer/relayerClient.ts` | Create — HTTP client |
| `usdc-v2-frontend/src/services/relayer/index.ts` | Create — exports |
| `usdc-v2-frontend/src/config/relayer.ts` | Create — relayer config |
| `usdc-v2-frontend/src/lib/sdk.ts` | Modify — add relayer fee to proofs, relayer submission path |
| `usdc-v2-frontend/src/services/yield/shieldedYieldService.ts` | Modify — add relayer fee to cross-contract proofs, relayer submission |
| `usdc-v2-frontend/src/hooks/useShieldedYieldTransaction.ts` | Modify — update stage labels for relayer mode |

### 2.6 Testing Phase 2

1. Start chains, deploy, start armada relayer
2. Start frontend (`npm run demo`)
3. Create shielded wallet, shield USDC (still user-submitted via MetaMask)
4. Execute private transfer — should go through relayer (no MetaMask popup for submission)
5. Execute unshield — should go through relayer
6. Execute shielded lend/redeem — should go through relayer
7. Verify relayer wallet receives fees (check USDC balance)

---

## Phase 3: CCTP Relay Integration

**Goal**: Merge the existing CCTP relay (`relay-v2.ts`) into the armada relayer as a module, so there's a single relayer process.

### 3.1 Extract CCTP Module (`modules/cctp-relay.ts`)

Refactor `relay-v2.ts` into a module class:

```typescript
class CCTPRelayModule {
  constructor(config: CCTPConfig, walletManager: WalletManager) {}
  async start(): Promise<void>  // Begin polling loop
  stop(): void                  // Stop polling
}
```

Key changes from current relay-v2.ts:
- Use shared `WalletManager` instead of managing its own wallet/nonce
- Export as a module class instead of standalone script
- Keep the same polling + relay logic

### 3.2 Unified Entry Point (`armada-relayer.ts`)

```typescript
async function main() {
  const walletManager = new WalletManager(config)
  const feeCalculator = new FeeCalculator(config)
  const privacyRelay = new PrivacyRelay(config, walletManager, feeCalculator)
  const cctpRelay = new CCTPRelayModule(config, walletManager)
  const httpApi = new HttpApi(config, privacyRelay, feeCalculator)

  await walletManager.initialize()
  await cctpRelay.start()       // Background polling
  await httpApi.start()          // HTTP server
}
```

### 3.3 Deprecate relay-v2.ts

After merge:
- Remove `npm run relayer` script (or redirect to armada-relayer)
- Add `npm run armada-relayer` that runs the unified process
- Update README with new setup instructions

### Files to create/modify:
| File | Action |
|------|--------|
| `relayer/modules/cctp-relay.ts` | Create — extracted from relay-v2.ts |
| `relayer/armada-relayer.ts` | Modify — integrate CCTP module |
| `relayer/relay-v2.ts` | Keep for reference, mark deprecated |
| `package.json` | Modify — update scripts |

---

## Phase 4: Cross-Chain Shield Fee Deduction (Contract Changes)

**Goal**: Relayer collects a fee from cross-chain shield operations. The fee is encoded in the CCTP message and deducted on the hub side.

### 4.1 Contract: CCTPTypes.sol

Add `relayerFee` field to `ShieldData`:

```solidity
struct ShieldData {
    bytes32 npk;
    uint120 value;
    bytes32[3] encryptedBundle;
    bytes32 shieldKey;
    uint256 relayerFee;           // NEW: fee for hub-side execution
}
```

No changes to `CCTPPayloadLib` needed — `abi.encode` handles the new field automatically.

### 4.2 Contract: PrivacyPoolClient.sol

Update `crossChainShield()` to accept relayer fee:

```solidity
function crossChainShield(
    uint256 amount,
    uint256 relayerFee,              // NEW
    bytes32 npk,
    bytes32[3] calldata encryptedBundle,
    bytes32 shieldKey,
    bytes32 destinationCaller
) external returns (uint64) {
    require(relayerFee < amount, "fee exceeds amount");

    // ShieldData now includes relayerFee
    ShieldData memory shieldData = ShieldData({
        npk: npk,
        value: uint120(amount),        // Full amount (fee deducted on hub)
        encryptedBundle: encryptedBundle,
        shieldKey: shieldKey,
        relayerFee: relayerFee         // NEW
    });

    // ... rest unchanged (CCTP burn + encode)
}
```

### 4.3 Contract: ShieldModule.sol

Update `processIncomingShield()` to deduct fee:

```solidity
function processIncomingShield(
    uint256 amount,
    bytes calldata hookData
) external /* onlyRouter */ {
    CCTPPayload memory payload = CCTPPayloadLib.decode(hookData);
    ShieldData memory shieldData = CCTPPayloadLib.decodeShieldData(payload.data);

    uint256 relayerFee = shieldData.relayerFee;
    uint256 commitmentAmount = amount - relayerFee;

    // Transfer relayer fee to msg.sender (the relayer)
    if (relayerFee > 0) {
        IERC20(usdc).safeTransfer(msg.sender, relayerFee);
    }

    // Create shield commitment for reduced amount
    // Update shieldData.value to commitmentAmount
    shieldData.value = uint120(commitmentAmount);

    // ... proceed with shield using commitmentAmount
}
```

### 4.4 Frontend: Shield Service

Update `executeCrossChainShield()` in `shieldContractService.ts`:

```typescript
// Before:
const tx = await clientContract.crossChainShield(
  amountRaw, npk, encryptedBundle, shieldKey, destinationCaller
)

// After:
const relayerFee = await relayerClient.getFees()
const feeAmount = BigInt(relayerFee.fees.crossChainShield)
const tx = await clientContract.crossChainShield(
  amountRaw, feeAmount, npk, encryptedBundle, shieldKey, destinationCaller
)
```

Note: Cross-chain shields are still user-submitted on the client chain (user pays gas there). The relayer fee covers the hub-side `receiveMessage()` gas cost that the relayer pays.

### 4.5 CCTP Module: Fee Validation

Update `CCTPRelayModule` to check relayer fee before relaying:

```typescript
// In relayMessage():
// Parse hookData from message body to extract relayerFee
// Skip relay if relayerFee < minimumFee
```

### 4.6 Recompile + Redeploy

After contract changes:
- `npx hardhat compile`
- `npm run setup` (redeploy all contracts)
- Update deployment JSONs
- Restart relayer

### Files to create/modify:
| File | Action |
|------|--------|
| `contracts/privacy-pool/types/CCTPTypes.sol` | Modify — add relayerFee to ShieldData |
| `contracts/client/PrivacyPoolClient.sol` | Modify — accept relayerFee param |
| `contracts/privacy-pool/modules/ShieldModule.sol` | Modify — deduct and transfer fee |
| `usdc-v2-frontend/src/services/shield/shieldContractService.ts` | Modify — pass relayerFee |
| `relayer/modules/cctp-relay.ts` | Modify — validate relayerFee |
| `test/yield_integration.ts` | Modify — update shield calls with relayerFee=0 |

---

## Phase 5: Retry Queue + Error Handling

**Goal**: Add robustness to the relayer for production-like behavior.

### 5.1 CCTP Retry Queue

Add retry logic to CCTP relay module:
- Failed relays go into a retry queue
- Exponential backoff: 2s, 4s, 8s, 16s, 32s (max 5 retries)
- Message state machine: `detected → relaying → confirmed | failed | retrying`
- On-chain dedup check: Query `usedNonces` on MessageTransmitter before relay attempt

### 5.2 Transaction Deduplication

Hash-based cache in wallet manager:
- Hash = keccak256(to + data)
- 10-minute TTL
- Reject duplicate submissions with specific error code

### 5.3 Privacy Relay Error Responses

Structured error codes for the frontend:

| Code | Meaning | Frontend action |
|------|---------|----------------|
| `FEE_TOO_LOW` | Fee doesn't cover gas | Re-fetch fees, regenerate proof |
| `FEE_EXPIRED` | Fee quote TTL exceeded | Re-fetch fees, regenerate proof |
| `INVALID_TARGET` | Transaction targets unknown contract | Show error |
| `GAS_ESTIMATION_FAILED` | Transaction would revert | Show error, suggest retry |
| `DUPLICATE_TX` | Same transaction already submitted | Show existing txHash |
| `RELAYER_BUSY` | Wallet locked (concurrent tx) | Retry after delay |

### 5.3 Files to create/modify:
| File | Action |
|------|--------|
| `relayer/modules/cctp-relay.ts` | Modify — add retry queue |
| `relayer/modules/wallet-manager.ts` | Modify — add dedup cache |
| `relayer/modules/privacy-relay.ts` | Modify — structured errors |
| `relayer/types.ts` | Modify — add error types |

---

## Dependency Graph

```
Phase 1 (HTTP API + Wallet Manager)
  │
  ├──→ Phase 2 (Frontend Integration)
  │      │
  │      └──→ Phase 4 (Cross-Chain Shield Fees)
  │
  └──→ Phase 3 (CCTP Merge)
         │
         └──→ Phase 4 (Cross-Chain Shield Fees)
                │
                └──→ Phase 5 (Retry + Error Handling)
```

Phases 2 and 3 can be done in parallel after Phase 1. Phase 4 requires both. Phase 5 can be done at any point after Phase 3.

---

## What's NOT In Scope (Defer to Testnet/Production)

| Item | Reason |
|------|--------|
| Circle attestation API integration | Local CCTP auto-approves; real attestations only on testnet |
| Waku P2P transport | HTTP is functionally equivalent; Waku needs network peers |
| Multi-wallet pool | Single wallet sufficient for local; add for throughput on testnet |
| ETH/USDC price oracle | Hardcoded locally; Chainlink on testnet |
| HSM / key rotation | Not relevant for local dev |
| Multi-relayer competition | Needs multiple instances on testnet |
| Nonce persistence across restarts | In-memory sufficient for local dev |

---

## Verification Checklist

After all phases, verify these end-to-end flows work:

- [ ] **Shield (hub)**: User submits directly via MetaMask → USDC enters privacy pool
- [ ] **Shield (cross-chain)**: User submits on client → CCTP relay → hub shield with fee deduction → relayer receives fee
- [ ] **Transfer**: Frontend generates proof with relayer fee → submits to relayer API → relayer executes → relayer receives fee
- [ ] **Unshield (hub)**: Frontend generates proof with relayer fee → submits to relayer → USDC goes to recipient → relayer receives fee
- [ ] **Unshield (cross-chain)**: Same as hub unshield but atomicCrossChainUnshield triggers CCTP back to client
- [ ] **Shielded lend**: Frontend generates cross-contract proof with relayer fee → relayer executes relay() → USDC→ayUSDC
- [ ] **Shielded redeem**: Same pattern → ayUSDC→USDC
- [ ] **Fee display**: Frontend shows relayer fee before proof generation
- [ ] **No ETH needed**: User can perform all privacy operations without holding ETH (except initial shield + approve on client chain)
