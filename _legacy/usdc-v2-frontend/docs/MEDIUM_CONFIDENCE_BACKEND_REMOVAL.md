# Medium Confidence Backend Removal Items - Review & Clarification

This document reviews items that may be related to backend functionality but need clarification before removal.

## Executive Summary

**Quick Actions (High Confidence - Safe to Remove):**
- ✅ Delete `flowStorageService.ts` (deprecated, unused)
- ✅ Delete `flowStatusMapper.ts` (dead code, unused)
- ✅ Remove `initiateFlow()` and `getFlowInitiation()` methods (unused)
- ✅ Remove `flowId` parameter from save functions (always `undefined`)
- ✅ Remove `flowMetadata.flowId` and `status` fields from `FlowInitiationMetadata`

**Needs User Input:**
- ⚠️ **`flowId` field in transactions** - Still read in 4 places, needs refactoring before removal
- ⚠️ **`isFrontendOnly` flag** - Should we remove it entirely or keep for UI display?

## Overview

After removing high-confidence backend code, there are several items that may or may not be backend-related. This document identifies them and asks clarifying questions.

---

## 1. `flowId` Field in Transactions

### Current State
- **Location:** `src/types/tx.ts` - `TrackedTransaction.flowId?: string`
- **Usage:** 
  - Stored in transactions but always `undefined` now (pages pass `undefined`)
  - Used in polling system, but **actually refers to `txId`** (transaction ID), not backend flowId
  - Comment says: "Backend flowId (canonical identifier after flow registration)"

### Questions:
1. **Is `flowId` field still needed?**
   - Frontend polling uses `txId` as the flow identifier
   - The `flowId` field in transactions is always `undefined` now
   - **Recommendation:** Can be removed from `TrackedTransaction` interface, but verify no code reads it

2. **Naming Confusion:**
   - Polling system uses `flowId` parameter but it's actually `txId`
   - Should we rename `flowId` to `txId` in polling interfaces for clarity?
   - **Recommendation:** Keep as-is for now (would be a larger refactor), but document the naming

### Action Items:
- [x] **VERIFIED:** `flowId` is still read in several places:
  - `useTxTracker.ts` - reads `tx.flowId` and checks `if (!tx.flowId)`
  - `TransactionDetailModal.tsx` - displays `transaction.flowId` if it exists (line 611)
  - `txSubmitter.ts` - uses `tx.flowId || tx.flowMetadata?.localId || tx.id` as fallback (3 places)
  - `transactionStorageService.ts` - has `getTransactionByFlowId()` method
- [ ] **ACTION NEEDED:** Update all usages to use `localId` or `id` instead, then remove `flowId` field
- [ ] Update comment in `tx.ts` to clarify it's deprecated

---

## 2. `flowMetadata.flowId` in FlowInitiationMetadata

### Current State
- **Location:** `src/types/flow.ts` - `FlowInitiationMetadata.flowId?: string`
- **Usage:**
  - Comment says: "Backend flowId (set after initial backend call)"
  - Always `undefined` now since backend registration is removed
  - `flowMetadata` itself is still used (contains `localId`, `flowType`, etc.)

### Questions:
1. **Is `flowMetadata.flowId` still needed?**
   - It was only set after backend registration
   - Frontend uses `localId` for identification
   - **Recommendation:** Can be removed from interface

### Action Items:
- [ ] Remove `flowId?: string` from `FlowInitiationMetadata` interface
- [ ] Update comment to remove backend reference

---

## 3. `flowId` Parameter in Save Functions

### Current State
- **Location:** 
  - `src/services/deposit/depositService.ts` - `saveDepositTransaction(..., flowId?: string)`
  - `src/services/payment/paymentService.ts` - `savePaymentTransaction(..., flowId?: string)`
- **Usage:**
  - Always called with `undefined` from pages
  - Function logic checks `if (flowId && !flowMetadata)` but this never happens now

### Questions:
1. **Can we remove the `flowId` parameter?**
   - Always `undefined` in all call sites
   - Logic that uses it is dead code
   - **Recommendation:** Yes, can be removed

### Action Items:
- [ ] Remove `flowId?: string` parameter from both save functions
- [ ] Remove dead code that checks `if (flowId && !flowMetadata)`
- [ ] Update function signatures and call sites

---

## 4. `frontendOnlyModeAtom` and `isFrontendOnly` Flag

### Current State
- **Location:** 
  - `src/atoms/appAtom.ts` - `frontendOnlyModeAtom`
  - Used in `depositService.ts` and `paymentService.ts`
  - Used in UI components (`TransactionDetailModal.tsx`, `TransactionCard.tsx`)
- **Usage:**
  - Sets `isFrontendOnly: true` on transactions
  - Used to determine if transaction should show "Frontend Only" badge
  - Used in status logic: `status: isFrontendOnly && !flowId ? 'undetermined' : tx.status`

### Questions:
1. **Is `frontendOnlyModeAtom` still needed?**
   - Since backend is removed, ALL transactions are frontend-only
   - The flag might be redundant now
   - **Recommendation:** Can be removed, always set `isFrontendOnly: true` (or remove field entirely)

2. **Should `isFrontendOnly` field be removed?**
   - If all transactions are frontend-only, the field is redundant
   - UI still shows "Frontend Only" badge based on this
   - **Recommendation:** Remove the field and badge (or keep badge but always show it)

### Action Items:
- [ ] Remove `frontendOnlyModeAtom` from `appAtom.ts`
- [ ] Remove `isFrontendOnly` checks from save functions
- [ ] Remove `isFrontendOnly` field from `StoredTransaction` interface
- [ ] Update UI components to remove "Frontend Only" badge (or always show it)

---

## 5. `flowStorageService.ts` - Entire File

### Current State
- **Location:** `src/services/flow/flowStorageService.ts`
- **Status:** All methods marked `@deprecated`
- **Usage:** 
  - Only used internally (no external imports found)
  - Methods delegate to `transactionStorageService` now

### Questions:
1. **Can we delete this file?**
   - All methods are deprecated
   - No external usage found
   - **Recommendation:** Yes, can be deleted

### Action Items:
- [ ] Verify no imports of `flowStorageService`
- [ ] Delete `src/services/flow/flowStorageService.ts`

---

## 6. `flowStatusMapper.ts` - Backend FlowStatus Usage

### Current State
- **Location:** `src/services/flow/flowStatusMapper.ts`
- **Usage:**
  - Functions accept `flowStatus?: FlowStatus` parameter (backend type)
  - But also accepts `tx?: StoredTransaction` for frontend polling
  - Has fallback logic for both backend and frontend paths

### Questions:
1. **Is `flowStatus` parameter still needed?**
   - Functions have two code paths: backend (`flowStatus`) and frontend (`tx`)
   - Frontend path is primary now
   - **Recommendation:** Remove `flowStatus` parameter, keep only `tx` path

2. **Can we simplify these functions?**
   - Remove backend `FlowStatus` handling
   - Keep only frontend `pollingState` reading
   - **Recommendation:** Yes, simplify to frontend-only

### Action Items:
- [x] **VERIFIED:** `flowStatusMapper.ts` functions are **NOT USED** anywhere in the codebase
  - UI uses `transactionStatusService.ts` instead
  - No imports found for `flowStatusMapper`
- [ ] **ACTION NEEDED:** Delete entire `flowStatusMapper.ts` file (dead code)

---

## 7. `FlowInitiationMetadata.flowId` Comment

### Current State
- **Location:** `src/types/flow.ts` line 29
- **Comment:** "Backend flowId (set after initial backend call)"

### Questions:
1. **Should comment be updated?**
   - Field is unused now
   - **Recommendation:** Remove field entirely (see item #2)

---

## 8. `flowInitiationService.initiateFlow()` Method

### Current State
- **Location:** `src/services/flow/flowInitiationService.ts`
- **Status:** Marked `@deprecated`
- **Usage:** Need to check if still called anywhere

### Questions:
1. **Is `initiateFlow()` still used?**
   - Marked deprecated in favor of `createFlowMetadata()`
   - **Recommendation:** Check usage, remove if unused

### Action Items:
- [x] **VERIFIED:** `initiateFlow()` is **NOT CALLED** anywhere (only defined)
- [ ] **ACTION NEEDED:** Remove `initiateFlow()` method from `flowInitiationService.ts`

---

## 9. `flowInitiationService.getFlowInitiation()` Method

### Current State
- **Location:** `src/services/flow/flowInitiationService.ts`
- **Status:** Marked `@deprecated`
- **Usage:** Need to check if still called anywhere

### Questions:
1. **Is `getFlowInitiation()` still used?**
   - Marked deprecated in favor of `transactionStorageService.getTransactionByLocalId()`
   - **Recommendation:** Check usage, remove if unused

### Action Items:
- [x] **VERIFIED:** `getFlowInitiation()` is **NOT CALLED** anywhere (only defined)
- [ ] **ACTION NEEDED:** Remove `getFlowInitiation()` method from `flowInitiationService.ts`

---

## 10. `FlowInitiationMetadata.status` Field

### Current State
- **Location:** `src/types/flow.ts` - `status: 'initiating' | 'tracking' | 'completed' | 'failed'`
- **Usage:** 
  - Set to `'initiating'` when created
  - Was updated to `'tracking'` after backend registration
  - Now never updated

### Questions:
1. **Is `status` field still needed?**
   - Never updated after creation
   - Transaction has its own `status` field
   - **Recommendation:** Can be removed (redundant with transaction status)

### Action Items:
- [ ] Remove `status` field from `FlowInitiationMetadata`
- [ ] Update `createFlowMetadata()` to not set status

---

## Summary of Recommendations

### High Confidence (Safe to Remove):
1. ✅ Remove `flowId` parameter from save functions
2. ✅ Delete `flowStorageService.ts` file
3. ✅ Remove `flowMetadata.flowId` from `FlowInitiationMetadata`
4. ✅ Remove `FlowInitiationMetadata.status` field
5. ✅ Remove `initiateFlow()` method (verified unused)
6. ✅ Remove `getFlowInitiation()` method (verified unused)
7. ✅ Delete `flowStatusMapper.ts` file (verified unused - dead code)

### Medium Confidence (Need Verification):
1. ⚠️ **Remove `flowId` field from `TrackedTransaction`** - Still read in 4 places, need to update usages first:
   - `useTxTracker.ts` - Update to use `localId` or `id`
   - `TransactionDetailModal.tsx` - Remove display of `flowId` (or show `localId` instead)
   - `txSubmitter.ts` - Already has fallback, can remove `flowId` from fallback chain
   - `transactionStorageService.ts` - Remove `getTransactionByFlowId()` method
2. ⚠️ **Remove `frontendOnlyModeAtom` and `isFrontendOnly` field** (verify UI impact)

### Low Confidence (Keep for Now):
1. ⚠️ Rename `flowId` to `txId` in polling interfaces (larger refactor, not urgent)

---

## Questions for User

1. **Should we remove the `isFrontendOnly` field entirely?** Since all transactions are frontend-only now, the field seems redundant. Or should we keep it for UI display purposes?

2. **Should we remove the "Frontend Only" badge from the UI?** Or keep it to indicate the app is frontend-only?

3. **Are there any edge cases where `flowId` might still be set?** (e.g., old transactions in localStorage)

4. **Should we do a migration pass to clean up old transactions?** Remove `flowId` from existing stored transactions?

