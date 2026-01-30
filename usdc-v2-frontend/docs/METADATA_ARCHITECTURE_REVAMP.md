# Metadata Architecture Revamp Proposal

## Current Problems

1. **Multiple Sources of Truth**: Metadata exists in:
   - `chainParams[initialChain].metadata` (initial metadata)
   - `chainParams[chain].metadata` (per-chain metadata, should include initial)
   - `chainStatus[chain].metadata` (status metadata, separate)
   - Complex merge logic tries to preserve initial metadata but fails

2. **Fragile Merge Logic**: 
   - Shallow merges lose nested data
   - Deep merges are complex and error-prone
   - Updates can accidentally overwrite initial metadata

3. **Hard to Debug**: 
   - Unclear where metadata should be read from
   - Multiple merge points make it hard to trace data flow
   - State can become inconsistent

## Proposed Solution: Single Progressive Metadata Object

### Core Principle
**One metadata object that starts with initial fields and gets progressively filled in as chains complete**

### Architecture

```
PollingState {
  // NEW: SINGLE SOURCE OF TRUTH for metadata
  // One metadata object that grows as polling progresses
  // Starts with initial fields, gets filled in step-by-step as each chain completes
  metadata: {
    // Initial fields (set at flow start, never modified)
    flowType: 'deposit' | 'payment'
    chainKey?: string  // EVM chain for deposit, EVM chain for payment
    txHash?: string  // Initial tx hash
    expectedAmountUusdc?: string  // Deposit only
    namadaReceiver?: string  // Deposit only
    forwardingAddress?: string  // Deposit only
    namadaBlockHeight?: number  // Payment only
    namadaIbcTxHash?: string  // Payment only
    recipient?: string
    amountBaseUnits?: string
    
    // Filled in progressively as chains complete:
    
    // After EVM polling (deposit flow):
    cctpNonce?: number
    irisLookupID?: string
    attestation?: string
    sourceDomain?: number
    destinationDomain?: number
    evmBlockNumber?: number
    
    // After Noble polling:
    packetSequence?: string
    nobleForwardingRegistrationTxHash?: string
    nobleHeight?: number
    nobleTxHash?: string
    
    // After Namada polling:
    namadaHeight?: number
    namadaTxHash?: string
    namadaStartHeight?: number  // For deposit flow
  }
  
  // PRESERVE ALL EXISTING FIELDS - DO NOT BREAK INTEGRATIONS
  
  // chainStatus: PRESERVED EXACTLY AS IS
  // Contains: stages, timestamps, status, completedStages, error info, etc.
  // Used by: stageUtils, transactionStatusService, UI components
  chainStatus: {
    evm?: ChainStatus  // stages[], completedStages[], status, timestamps, etc.
    noble?: ChainStatus
    namada?: ChainStatus
  }
  
  // chainParams: PRESERVED but metadata removed
  // Contains: poller config only (timeout, interval, abortSignal, flowId, chain)
  // Used by: pollers for configuration
  chainParams: {
    evm?: Omit<EvmPollParams, 'metadata'>  // Remove metadata, keep config
    noble?: Omit<NoblePollParams, 'metadata'>
    namada?: Omit<NamadaPollParams, 'metadata'>
  }
  
  // All other existing fields preserved exactly as is
  flowStatus: FlowPollingStatus
  latestCompletedStage?: string
  currentChain?: ChainKey
  flowType: FlowType
  globalTimeoutAt?: number
  error?: {...}
  startedAt: number
  lastUpdatedAt: number
  lastActiveAt?: number
}
```

### Preservation Strategy

**CRITICAL**: We must preserve all existing data structures to maintain compatibility:

1. **`chainStatus`**: Keep exactly as is
   - Contains: `stages[]`, `completedStages[]`, `status`, `errorType`, `errorMessage`, `completedAt`, `retryCount`, etc.
   - Used by: `stageUtils.getAllStagesFromTransaction()`, `transactionStatusService.getStageTimings()`, UI components
   - **No changes to structure or access patterns**

2. **`chainParams`**: Keep structure but remove `metadata` field
   - Contains: `flowId`, `chain`, `timeoutMs`, `intervalMs`, `abortSignal`
   - Used by: Pollers for configuration
   - **Only change**: Remove `metadata` field, pollers read from `pollingState.metadata` instead

3. **All other fields**: Preserved exactly as is
   - `flowStatus`, `latestCompletedStage`, `currentChain`, `flowType`, `globalTimeoutAt`, `error`, `startedAt`, `lastUpdatedAt`, `lastActiveAt`
   - **No changes**

4. **New field**: `metadata` (additive only)
   - New top-level field
   - Does not replace or modify existing fields
   - **Additive change only**

### Key Changes

1. **Single `metadata` object**: One progressive metadata object that starts with initial fields and gets filled in as chains complete
2. **`chainParams`**: Keep for poller configuration only (timeout, interval, abortSignal), remove metadata
3. **Metadata Access Pattern**: Always read from `pollingState.metadata` - it contains everything (initial + progressive)

### Why This Approach?

- **Simpler**: One object to read from, one object to write to
- **Progressive**: Starts with initial fields, fills in as we go
- **No Merging**: Just update the single metadata object with new fields
- **Clear**: All metadata in one place, easy to see what's available at any stage
- **Resumable**: Metadata object persists, can resume from any point

### Implementation Steps

#### Step 1: Update Types

```typescript
export interface PollingState {
  // ... existing fields ...
  
  /** Single progressive metadata object - starts with initial fields, fills in as chains complete */
  metadata: Record<string, unknown>
  
  // Remove metadata from chainParams - it's now only for poller config
  chainParams: {
    evm?: Omit<EvmPollParams, 'metadata'>
    noble?: Omit<NoblePollParams, 'metadata'>
    namada?: Omit<NamadaPollParams, 'metadata'>
  }
}
```

#### Step 2: Update Initialization

```typescript
// In initializePollingState or startFlow
// Set initial metadata - this is the starting point
updatePollingState(txId, {
  metadata: {
    // Initial fields available at flow start
    flowType: 'deposit',
    chainKey: 'avalanche-fuji',
    txHash: '0x...',
    expectedAmountUusdc: '100000uusdc',
    namadaReceiver: 'namada1...',
    forwardingAddress: 'noble1...',
    recipient: 'noble1...',
    amountBaseUnits: '100000',
    // Fields that will be filled in later are undefined for now
    // cctpNonce: undefined (will be filled after EVM)
    // packetSequence: undefined (will be filled after Noble)
    // etc.
  },
})
```

#### Step 3: Update buildPollParams

```typescript
private async buildPollParams(chain: ChainKey, ...): Promise<ChainPollParams> {
  const state = getPollingState(this.txId)
  
  // Simple: Just read from the single metadata object
  // It already contains initial fields + all previous chain results
  const metadata = {
    ...state.metadata,  // Everything is already here!
  }
  
  return {
    ...state.chainParams[chain],
    metadata,  // Pass the complete metadata object
    // ... other params (timeout, interval, abortSignal)
  }
}
```

**That's it!** No complex merging, no multiple sources of truth. Just read from `state.metadata`.

#### Step 4: Update processChainResult

```typescript
private async processChainResult(chain: ChainKey, result: ChainPollResult): Promise<void> {
  const state = getPollingState(this.txId)
  
  // Simple: Just update the single metadata object with new fields from this chain
  updatePollingState(this.txId, {
    metadata: {
      ...state.metadata,  // Preserve existing (initial + previous chains)
      ...result.metadata,  // Add new fields from this chain's results
    },
  })
  
  // Update chainStatus (stages, status, etc.)
  updateChainStatus(this.txId, chain, {
    status: result.success ? 'success' : 'polling_error',
    stages: result.stages,
    // ... other status fields
  })
}
```

**That's it!** Just spread existing metadata and add new fields. No complex merging logic needed.

#### Step 5: Update Chain Pollers

Chain pollers receive the complete metadata object (initial + previous chains) and return only NEW fields they discovered:

```typescript
// EVM Poller receives complete metadata, returns only NEW fields
// It already has: txHash, chainKey, expectedAmountUusdc, etc.
// It returns: cctpNonce, irisLookupID, attestation (NEW fields)
return {
  success: true,
  found: true,
  metadata: {
    cctpNonce: 12345,  // NEW field
    irisLookupID: '0x...',  // NEW field
    attestation: '0x...',  // NEW field
    sourceDomain: 1,  // NEW field
    destinationDomain: 4,  // NEW field
    // Does NOT return: txHash, chainKey, etc. (already in metadata)
  },
  stages: [...],
}
```

### Benefits

1. **Single Source of Truth**: One `metadata` object contains everything (initial + progressive)
2. **No Complex Merging**: Just spread existing metadata and add new fields
3. **Progressive Filling**: Starts with initial fields, fills in step-by-step as chains complete
4. **Easy to Debug**: Always read from `state.metadata`, always write to `state.metadata`
5. **Resumable**: Metadata object persists, can resume from any point
6. **Simple**: No need to track what's "initial" vs "result" - it's all in one place
7. **Type Safe**: Can type the complete metadata structure if desired

### Migration Strategy

**CRITICAL**: Preserve all existing data structures and access patterns

1. **Add `metadata` field to `PollingState` type** (additive only)
   - New field, does not modify existing fields
   - Existing code continues to work

2. **Update initialization to set `metadata`**
   - Extract initial metadata from transaction details
   - Set `pollingState.metadata = { initial fields }`
   - Keep all existing initialization logic

3. **Update `buildPollParams` to read from `metadata`**
   - Change: Read from `state.metadata` instead of `state.chainParams[chain].metadata`
   - Keep: All other poller config from `chainParams`

4. **Update `processChainResult` to write to `metadata`**
   - Change: Update `state.metadata` with new fields instead of `chainParams[chain].metadata`
   - Keep: All `chainStatus` updates (stages, timestamps, status) exactly as is

5. **Remove metadata from `chainParams`** (gradual migration)
   - Keep `chainParams` structure for poller config
   - Remove `metadata` field from `chainParams` type
   - Pollers read metadata from `pollingState.metadata` instead

6. **Add migration logic** (backward compatibility)
   - Detect old structure (metadata in `chainParams`)
   - Migrate to new structure (metadata in top-level `metadata`)
   - Preserve all existing `chainStatus` data

7. **Verify integrations still work**
   - `stageUtils.getAllStagesFromTransaction()` - reads from `chainStatus[chain].stages[]` ✅
   - `transactionStatusService.getStageTimings()` - reads from `chainStatus[chain].stages[]` ✅
   - UI components - read from `chainStatus` ✅
   - Storage model - all fields preserved ✅

### Backward Compatibility Guarantees

- ✅ `chainStatus` structure unchanged - all stage/timestamp reading code works
- ✅ `chainParams` structure preserved (just metadata removed) - poller config still works
- ✅ All other `PollingState` fields unchanged
- ✅ Migration function handles old structure automatically
- ✅ No breaking changes to existing APIs or data access patterns

### Example Flow

**Deposit Flow:**

1. **Start**: Set `metadata = { flowType: 'deposit', txHash: '0x...', expectedAmountUusdc: '...', namadaReceiver: '...', forwardingAddress: '...', ... }`
   - Contains: Initial fields needed to start EVM polling
   - Missing: cctpNonce, packetSequence, etc. (will be filled later)

2. **EVM Polling**: 
   - Read: `metadata` (has txHash, chainKey, etc.)
   - Return: `{ cctpNonce: 12345, irisLookupID: '0x...', attestation: '0x...' }`
   - Update: `metadata = { ...existingMetadata, cctpNonce: 12345, irisLookupID: '0x...', attestation: '0x...' }`
   - Now contains: Initial fields + EVM results

3. **Noble Polling**:
   - Read: `metadata` (has cctpNonce from EVM)
   - Return: `{ packetSequence: '123', nobleForwardingRegistrationTxHash: '0x...' }`
   - Update: `metadata = { ...existingMetadata, packetSequence: '123', ... }`
   - Now contains: Initial fields + EVM results + Noble results

4. **Namada Polling**:
   - Read: `metadata` (has packetSequence from Noble)
   - Return: `{ namadaTxHash: '0x...', namadaHeight: 12345 }`
   - Update: `metadata = { ...existingMetadata, namadaTxHash: '0x...', ... }`
   - Now contains: Initial fields + EVM results + Noble results + Namada results

**Payment Flow:**

1. **Start**: Set `metadata = { flowType: 'payment', namadaBlockHeight: 12345, namadaIbcTxHash: '0x...', evmChainKey: 'avalanche-fuji', ... }`
2. **Namada Polling**: Read metadata, return `{ packetSequence: '123' }`, update metadata
3. **Noble Polling**: Read metadata (has packetSequence), return `{ cctpNonce: 12345 }`, update metadata
4. **EVM Polling**: Read metadata (has cctpNonce), return `{ evmTxHash: '0x...' }`, update metadata

### Backward Compatibility

Add migration function to convert old structure:

```typescript
function migratePollingState(oldState: PollingState): PollingState {
  // Collect all metadata from chainParams[chain].metadata into single object
  const metadata: Record<string, unknown> = {}
  
  // Start with initial chain metadata (has initial fields)
  const initialChain = oldState.flowType === 'deposit' ? 'evm' : 'namada'
  const initialMetadata = oldState.chainParams[initialChain]?.metadata || {}
  Object.assign(metadata, initialMetadata)
  
  // Add metadata from other chains (has progressive fields)
  for (const chain of ['evm', 'noble', 'namada'] as const) {
    const chainMetadata = oldState.chainParams[chain]?.metadata || {}
    // Merge in, newer chains overwrite older ones (correct behavior)
    Object.assign(metadata, chainMetadata)
  }
  
  return {
    ...oldState,
    metadata,  // Single metadata object
    chainParams: {
      // Remove metadata from chainParams, keep only config
      evm: oldState.chainParams.evm ? { ...oldState.chainParams.evm, metadata: undefined } : undefined,
      noble: oldState.chainParams.noble ? { ...oldState.chainParams.noble, metadata: undefined } : undefined,
      namada: oldState.chainParams.namada ? { ...oldState.chainParams.namada, metadata: undefined } : undefined,
    },
  }
}
```

