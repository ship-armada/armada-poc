# Metadata Flow Analysis

## Overview

This document explains how metadata flows through the polling system, why it's problematic to preserve, and proposes a solution.

## Current Metadata Flow

### 1. **Initialization** (`initializePollingState` or `startFlow`)
- Initial metadata is created with fields like:
  - `expectedAmountUusdc`, `namadaReceiver`, `forwardingAddress` (for deposit flows)
  - `namadaBlockHeight`, `namadaIbcTxHash` (for payment flows)
- Stored in `pollingState.chainParams[initialChain].metadata`
- **Location**: `StoredTransaction.pollingState.chainParams.evm.metadata` (deposit) or `chainParams.namada.metadata` (payment)

### 2. **Building Poll Parameters** (`buildPollParams`)
- Reads `state.chainParams[chain].metadata` to build poll parameters
- Should preserve initial metadata, but currently loses it
- Creates `ChainPollParams` object with metadata to pass to poller

### 3. **Chain Polling** (`evmPoller`, `noblePoller`, `namadaPoller`)
- Receives metadata via `ChainPollParams.metadata`
- Extracts chain-specific data (e.g., `cctpNonce`, `packetSequence`, `irisLookupID`)
- Returns `ChainPollResult` with new metadata fields

### 4. **Processing Results** (`processChainResult`)
- Merges result metadata with existing metadata
- Should preserve initial metadata, but currently loses it
- Updates `chainParams[chain].metadata` in state

### 5. **Next Chain** (`buildPollParams` for next chain)
- Reads metadata from previous chain's `chainParams`
- Should include initial metadata + previous chain's result metadata
- Currently loses initial metadata

## The Problem

### Root Cause: Shallow Merge in `updatePollingState`

The `updatePollingState` function does a shallow merge:

```typescript
chainParams: {
  ...currentState?.chainParams,
  ...updates.chainParams,
}
```

**Problem**: When `updates.chainParams` is `{}` (empty object), it doesn't overwrite, but when it's a partial object like `{ evm: { metadata: {...} } }`, it **replaces** the entire `evm` entry, losing other fields like `flowId`, `timeoutMs`, `abortSignal`, etc.

**Even worse**: When `startFlow` calls `updatePollingState` with `chainParams: chainParamsToUse`, if `chainParamsToUse` is constructed incorrectly or if there's a race condition, the initial metadata gets lost.

### Why It's Problematic

1. **Multiple Sources of Truth**: Metadata exists in:
   - `chainParams[initialChain].metadata` (initial metadata)
   - `chainParams[chain].metadata` (per-chain metadata, should include initial)
   - `chainStatus[chain].metadata` (status metadata, separate from params)

2. **Shallow Merging**: The spread operator `{...a, ...b}` does a shallow merge, so nested objects get replaced entirely, not merged.

3. **Timing Issues**: State reads might be stale if multiple updates happen in quick succession.

4. **Complex Merge Logic**: We're trying to merge:
   - Initial metadata (from `chainParams[initialChain]`)
   - Existing metadata (from `chainParams[chain]`)
   - Result metadata (from poller)
   - Previous chain metadata (for next chain)

## Proposed Solution

### Option 1: Deep Merge in `updatePollingState` (Implemented)

Modify `updatePollingState` to do a deep merge of `chainParams`, preserving nested metadata:

```typescript
chainParams: updates.chainParams !== undefined
  ? {
      ...(currentState?.chainParams || {}),
      ...updates.chainParams,
      // Deep merge metadata for each chain
      ...(Object.keys(updates.chainParams || {}).reduce((acc, chainKey) => {
        const chain = chainKey as keyof typeof updates.chainParams
        const currentChainParams = currentState?.chainParams?.[chain]
        const updatedChainParams = updates.chainParams?.[chain]
        
        if (updatedChainParams) {
          acc[chain] = {
            ...currentChainParams,
            ...updatedChainParams,
            metadata: {
              ...(currentChainParams?.metadata || {}),
              ...(updatedChainParams.metadata || {}),
            },
          } as any
        } else if (currentChainParams) {
          acc[chain] = currentChainParams
        }
        return acc
      }, {} as typeof updates.chainParams)),
    }
  : (currentState?.chainParams || {}),
```

### Option 2: Single Source of Truth (Better Long-term)

Instead of trying to preserve initial metadata in multiple places, store it once and reference it:

1. Store initial metadata in `pollingState.initialMetadata` (separate from chainParams)
2. When building poll params, always merge `initialMetadata` + `chainParams[chain].metadata`
3. When processing results, merge `initialMetadata` + existing + result

This eliminates the need for complex merge logic and ensures initial metadata is always available.

### Option 3: Immutable Updates (Best Practice)

Use a library like `immer` or implement immutable update patterns to ensure state updates are predictable and don't have side effects.

## Differences: Deposit vs Payment Flows

### Deposit Flow
- **Initial Chain**: EVM
- **Initial Metadata**: `expectedAmountUusdc`, `namadaReceiver`, `forwardingAddress`, `txHash`, `chainKey`
- **Flow**: EVM → Noble → Namada
- **Metadata Propagation**:
  - EVM extracts `cctpNonce` → passes to Noble
  - Noble extracts `packetSequence` → passes to Namada
  - Initial metadata should be preserved throughout

### Payment Flow
- **Initial Chain**: Namada
- **Initial Metadata**: `namadaBlockHeight`, `namadaIbcTxHash`, `evmChainKey`, `recipient`, `amountBaseUnits`
- **Flow**: Namada → Noble → EVM
- **Metadata Propagation**:
  - Namada extracts `packetSequence` → passes to Noble
  - Noble extracts `cctpNonce` → passes to EVM
  - Initial metadata should be preserved throughout

## Why Not Just Read from Local Storage?

We **do** read from local storage (`transactionStorageService.getTransaction(txId)`), but the problem is:

1. **Stale Reads**: If multiple updates happen quickly, reads might be stale
2. **Merge Logic**: We still need to merge initial + existing + result metadata
3. **Performance**: Reading from localStorage on every operation is slower than in-memory state
4. **Consistency**: We need to ensure state is consistent across all reads

## Current Fix

The fix I've implemented does a deep merge in `updatePollingState` to preserve nested metadata. This should prevent initial metadata from being lost when updating chainParams.

However, the **better long-term solution** would be Option 2: Store initial metadata separately and always merge it when needed, eliminating the complexity of trying to preserve it in multiple places.

