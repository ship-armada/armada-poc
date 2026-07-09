# Low Confidence Backend Removal Items - Review & Clarification

This document identifies items that may be backend-related but need clarification before removal. These are items where the relationship to backend functionality is unclear or where removal might have broader implications.

---

## 1. `FlowStatus` Type and `flowStatusSnapshot` Field

### Current State
- **Location:** 
  - `src/types/flow.ts` - `FlowStatus` interface (lines 84-102)
  - `src/services/tx/transactionStorageService.ts` - `StoredTransaction.flowStatusSnapshot?: FlowStatus`
- **Usage:**
  - Comment says: "Flow status from backend (source of truth for live transaction status)"
  - Used in `transactionStatusService.ts` - `getEffectiveStatus()` checks `tx.flowStatusSnapshot?.status` as "Priority 1"
  - Used in `TransactionDetailModal.tsx` - checks `transaction.flowStatusSnapshot` for chain progress
  - Comment in `transactionStorageService.ts` says: "comes from backend API and is most accurate"

### Questions:
1. **Is `flowStatusSnapshot` still being populated?**
   - The comment suggests it comes from backend API
   - With backend removed, is this field ever set?
   - **Need to verify:** Is there any code that still sets `flowStatusSnapshot`?

2. **Should we remove `flowStatusSnapshot` handling?**
   - If it's never populated, the fallback logic in `getEffectiveStatus()` is dead code
   - The UI check in `TransactionDetailModal.tsx` would never be true
   - **Recommendation:** If never populated, remove the field and simplify status logic

3. **What about `FlowStatus` type definition?**
   - If `flowStatusSnapshot` is removed, `FlowStatus` type might only be used in comments
   - **Recommendation:** Remove if unused

### Action Items:
- [x] **VERIFIED:** No assignments to `flowStatusSnapshot` found - it's never set (dead code)
- [ ] **VERIFY:** Check if `FlowStatus` type is used anywhere else (besides `flowStatusSnapshot` field)
- [ ] **ACTION NEEDED:** Remove `flowStatusSnapshot` field and simplify `getEffectiveStatus()`
- [ ] **ACTION NEEDED:** Remove `FlowStatus` type definition if unused elsewhere
- [ ] Update comments that reference backend API

---

## 2. Backend-Related Type Definitions in `flow.ts`

### Current State
- **Location:** `src/types/flow.ts`
- **Types:**
  - `StartFlowTrackingInput` (lines 107-114) - "Input for starting flow tracking on backend"
  - `StartFlowTrackingResponse` (lines 119-126) - "Response from backend when starting flow tracking"
  - `ClientStageInput` (lines 131-141) - "Input for reporting client-side stage to backend"
  - `FlowStatus` (lines 84-102) - "Flow status from backend"

### Questions:
1. **Are these types still used?**
   - All have comments indicating they're for backend communication
   - **Need to verify:** Are any of these types imported/used anywhere?

2. **Should we remove unused backend types?**
   - If unused, they're just dead code
   - **Recommendation:** Remove if verified unused

### Action Items:
- [x] **VERIFIED:** 
  - `StartFlowTrackingInput` - **NOT USED** (only defined)
  - `StartFlowTrackingResponse` - **NOT USED** (only defined)
  - `ClientStageInput` - **USED** in `clientStageReporter.ts` (as `Partial<ClientStageInput>`)
  - `FlowStatus` - Only used in `flowStatusSnapshot` field (which is never set)
- [ ] **ACTION NEEDED:** Remove `StartFlowTrackingInput` and `StartFlowTrackingResponse` (unused)
- [ ] **QUESTION:** Should `ClientStageInput` be kept? It's used but the comment says it's for backend. Verify if it's actually needed for frontend-only operation.
- [ ] **ACTION NEEDED:** Remove `FlowStatus` if `flowStatusSnapshot` is removed

---

## 3. `TxStatusResponse` and `ApiError` in `api.ts`

### Current State
- **Location:** `src/types/api.ts`
- **Types:**
  - `TxStatusResponse` - Transaction status response structure
  - `ApiError` - API error structure
- **Comment:** "TODO: Align interfaces with backend contract once endpoints are finalized."

### Questions:
1. **Are these types still used?**
   - `TxStatusResponse` looks like it could be for backend API responses
   - `ApiError` is generic and might be used for other API calls (not just backend)
   - **Need to verify:** Are these types imported/used anywhere?

2. **Should we remove `TxStatusResponse`?**
   - If it's only for backend and backend is removed, it's dead code
   - **Recommendation:** Remove if unused

3. **Should we keep `ApiError`?**
   - Generic error type might be useful for other API calls
   - **Recommendation:** Keep if used elsewhere, remove if only for backend

### Action Items:
- [x] **VERIFIED:** 
  - `TxStatusResponse` - **NOT USED** (only defined)
  - `ApiError` - **NOT USED** (only defined)
- [ ] **ACTION NEEDED:** Remove both types (unused)

---

## 4. Backend Comments in Type Definitions

### Current State
- **Location:** `src/types/flow.ts`
- **Comments:**
  - Line 2: "Flow types for transaction status tracking and synchronization with backend."
  - Line 3: "These types match the backend flow model defined in usdc-v2-backend/docs/frontend-sync.md"
  - Line 87: "Backend flowId (canonical identifier)"
  - Line 93: "Per-chain progress (from backend)"
  - Various other references to "backend" in comments

### Questions:
1. **Should we update comments to remove backend references?**
   - Comments are outdated if backend is removed
   - **Recommendation:** Update comments to reflect frontend-only architecture

### Action Items:
- [ ] Update comments to remove backend references
- [ ] Update comments to clarify frontend-only architecture

---

## 5. Polling Interface Naming: `flowId` vs `txId`

### Current State
- **Location:** `src/services/polling/types.ts` - `BasePollParams.flowId: string`
- **Usage:**
  - Polling interfaces use `flowId` parameter
  - But it actually represents the transaction ID (`txId`), not a backend flowId
  - This is intentional and correct (not backend-related)

### Questions:
1. **Should we rename `flowId` to `txId` for clarity?**
   - Would reduce confusion about what it represents
   - Would be a larger refactor across all polling code
   - **Recommendation:** Low priority - naming is clear enough in context, but could be improved

### Action Items:
- [ ] **DECISION NEEDED:** Is this refactor worth the effort?
- [ ] If yes: Rename `flowId` to `txId` in polling interfaces
- [ ] Update all polling implementations to use `txId`

---

## 6. `flowStatusSnapshot` Priority Logic

### Current State
- **Location:** `src/services/tx/transactionStatusService.ts` - `getEffectiveStatus()`
- **Logic:**
  - Priority 1: `flowStatusSnapshot.status` (backend API)
  - Priority 2: `pollingState.flowStatus` (frontend polling)
  - Priority 3: Top-level `status` field

### Questions:
1. **Is the Priority 1 logic dead code?**
   - If `flowStatusSnapshot` is never populated, this check never succeeds
   - **Recommendation:** Remove Priority 1 if `flowStatusSnapshot` is removed

### Action Items:
- [ ] **DEPENDS ON:** Item #1 (flowStatusSnapshot removal)
- [ ] If `flowStatusSnapshot` is removed, simplify to:
  - Priority 1: `pollingState.flowStatus` (frontend polling)
  - Priority 2: Top-level `status` field

---

## Summary of Low Confidence Items

### Needs Verification:
1. ⚠️ **`flowStatusSnapshot` field** - Is it ever populated? If not, remove it and simplify status logic
2. ⚠️ **Backend type definitions** - `StartFlowTrackingInput`, `StartFlowTrackingResponse`, `ClientStageInput`, `FlowStatus` - Are they used?
3. ⚠️ **`TxStatusResponse` and `ApiError`** - Are they used? Remove if only for backend

### Low Priority (Naming/Clarity):
4. ⚠️ **Backend comments** - Update to reflect frontend-only architecture
5. ⚠️ **Polling interface naming** - Consider renaming `flowId` to `txId` for clarity (larger refactor)

### Depends on Other Items:
6. ⚠️ **Status priority logic** - Simplify if `flowStatusSnapshot` is removed

---

## Questions for User

1. **Is `flowStatusSnapshot` ever populated?** We see it being read in status logic, but need to verify if any code sets it. If not, we can remove it and simplify the status determination logic.

2. **Are the backend-related types (`StartFlowTrackingInput`, `StartFlowTrackingResponse`, `ClientStageInput`) still used anywhere?** If not, we can remove them as dead code.

3. **Are `TxStatusResponse` and `ApiError` used anywhere?** If only for backend, we can remove them.

4. **Should we update all backend-related comments?** Or is it okay to leave them as historical documentation?

5. **Is the `flowId` → `txId` rename in polling interfaces worth doing?** It would improve clarity but requires refactoring all polling code.

