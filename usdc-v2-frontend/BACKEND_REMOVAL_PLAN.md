# Backend Code Removal Plan - High Confidence Items

This document outlines the step-by-step plan to remove all high-confidence backend-related code from the frontend application.

## Overview

The app has been migrated to frontend-only polling (enabled via `VITE_ENABLE_FRONTEND_POLLING=true`). This plan removes all backend API client code, backend polling services, and related infrastructure that is no longer needed.

## Removal Order

### Phase 1: Remove Backend Function Calls from Pages

**Files to modify:**
1. `src/pages/Deposit.tsx`
   - Remove import: `postDepositToBackend`
   - Remove line 427: `const flowId = await postDepositToBackend(...)`
   - Update line 430: Change `saveDepositTransaction(txWithHash, transactionDetails, flowId)` to `saveDepositTransaction(txWithHash, transactionDetails, undefined)`

2. `src/pages/SendPayment.tsx`
   - Remove import: `postPaymentToBackend`
   - Remove line 290: `const flowId = await postPaymentToBackend(...)`
   - Update line 293: Change `savePaymentTransaction(txWithHash, transactionDetails, flowId)` to `savePaymentTransaction(txWithHash, transactionDetails, undefined)`

**Impact:** Pages will no longer attempt to register transactions with backend. Frontend polling will handle all tracking.

---

### Phase 2: Remove Backend Service Functions

**Files to modify:**

1. `src/services/deposit/depositService.ts`
   - Remove import: `import { trackNobleForwarding } from '@/services/api/backendClient'`
   - Remove function: `postDepositToBackend()` (lines 278-401)
   - Remove function: `registerNobleForwardingForTracking()` (lines 412-454)
   - Update comment on line 172: Remove reference to `postDepositToBackend`

2. `src/services/payment/paymentService.ts`
   - Remove function: `postPaymentToBackend()` (lines 623-726)
   - Update comment on line 550: Remove reference to `postPaymentToBackend`

**Impact:** Service layer no longer has backend registration functions. All tracking is handled by frontend polling.

---

### Phase 3: Remove Backend Registration from Flow Initiation Service

**File to modify:**
1. `src/services/flow/flowInitiationService.ts`
   - Remove import: `import { startFlowTracking } from '@/services/api/backendClient'`
   - Remove method: `registerWithBackend()` (lines 128-262)
   - Keep: `createFlowMetadata()` and `initiateFlow()` (still used for local flow metadata)

**Impact:** Flow initiation service no longer registers flows with backend. Flow metadata is still created locally for frontend tracking.

---

### Phase 4: Clean Up useTxTracker Hook

**File to modify:**
1. `src/hooks/useTxTracker.ts`
   - Remove imports:
     - `import { flowStatusPoller } from '@/services/flow/flowStatusPoller'`
     - `import { getFlowStatus } from '@/services/api/backendClient'`
     - `import { flowStatusCacheService } from '@/services/flow/flowStatusCacheService'`
   - Remove backend polling logic:
     - Lines 98-244: Backend flow status mapping and refresh logic
     - Lines 593-669: Backend status fetch before marking as 'undetermined'
     - Lines 876-957: Backend transaction filtering and polling setup
   - Keep: Frontend polling logic (orchestrator-based polling)

**Impact:** Hook only uses frontend polling. No backend status queries.

---

### Phase 5: Delete Backend Service Files

**Files to delete:**
1. `src/services/tx/txTracker.ts` - Entire file (uses backend polling)
2. `src/services/flow/flowStatusPoller.ts` - Entire file (polls backend API)
3. `src/services/flow/flowStatusCacheService.ts` - Entire file (caches backend responses)
4. `src/services/api/backendClient.ts` - Entire file (backend API client)

**Impact:** All backend communication infrastructure removed.

---

### Phase 6: Remove Environment Configuration

**File to modify:**
1. `src/config/env.ts`
   - Remove line 13: `backendUrl: () => readEnvVar('VITE_BACKEND_URL'),`

**Impact:** Environment no longer exposes backend URL configuration.

---

### Phase 7: Clean Up Type Definitions

**File to modify:**
1. `src/types/api.ts`
   - Remove `BackendConfig` interface (lines 1-4)
   - Keep `TxStatusResponse` and `ApiError` if used elsewhere (verify first)

**Impact:** Type definitions no longer include backend configuration types.

---

## Verification Steps

After completing all phases:

1. **Build Verification:**
   ```bash
   npm run build
   ```
   - Should compile without errors
   - No references to deleted files

2. **Runtime Verification:**
   ```bash
   npm run dev
   ```
   - App should start without errors
   - Deposit flow should work (frontend polling only)
   - Payment flow should work (frontend polling only)
   - Transaction history should display correctly

3. **Code Search:**
   ```bash
   # Verify no remaining imports
   grep -r "backendClient" src/
   grep -r "flowStatusPoller" src/
   grep -r "txTracker" src/
   grep -r "flowStatusCacheService" src/
   grep -r "postDepositToBackend" src/
   grep -r "postPaymentToBackend" src/
   grep -r "registerWithBackend" src/
   ```

## Dependencies Map

```
Pages (Deposit.tsx, SendPayment.tsx)
  └─> depositService.postDepositToBackend() ❌ REMOVE
  └─> paymentService.postPaymentToBackend() ❌ REMOVE

depositService.ts
  └─> flowInitiationService.registerWithBackend() ❌ REMOVE
  └─> backendClient.trackNobleForwarding() ❌ REMOVE

paymentService.ts
  └─> flowInitiationService.registerWithBackend() ❌ REMOVE

flowInitiationService.ts
  └─> backendClient.startFlowTracking() ❌ REMOVE

useTxTracker.ts
  └─> flowStatusPoller ❌ REMOVE
  └─> backendClient.getFlowStatus() ❌ REMOVE
  └─> flowStatusCacheService ❌ REMOVE

txTracker.ts ❌ DELETE ENTIRE FILE
flowStatusPoller.ts ❌ DELETE ENTIRE FILE
flowStatusCacheService.ts ❌ DELETE ENTIRE FILE
backendClient.ts ❌ DELETE ENTIRE FILE
```

## Notes

- All removed functions are already marked with `@deprecated LEGACY_BACKEND_CODE` comments
- Frontend polling is enabled via `VITE_ENABLE_FRONTEND_POLLING=true` (already set in `.env.local`)
- Flow metadata (`flowMetadata`) is still created locally but no longer synced with backend
- `flowId` field in transactions will no longer be set (can be removed in future cleanup if desired)

## Estimated Impact

- **Files to delete:** 4 files
- **Functions to remove:** ~8 functions
- **Lines of code to remove:** ~1,500-2,000 lines
- **Import statements to remove:** ~10-15 imports
- **Breaking changes:** None (backend code already disabled via feature flag)

