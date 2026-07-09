# Frontend Polling Migration Guide

## Overview

This document outlines the migration from backend-managed transaction polling to frontend-managed polling. The frontend now handles all chain polling directly, eliminating the need for backend status tracking while maintaining full transaction visibility and resumability.

## Migration Status

**Current State:** Frontend polling is implemented and available via feature flag `VITE_ENABLE_FRONTEND_POLLING`.

**Target State:** Complete removal of backend polling dependencies.

## Feature Flag

### Enabling Frontend Polling

Set the environment variable:
```bash
VITE_ENABLE_FRONTEND_POLLING=true
```

When enabled:
- New transactions use frontend polling via `chainPollingService`
- Transactions are tracked directly via `FlowOrchestrator`
- Status is stored in `pollingState` within transaction storage

When disabled (default):
- Transactions continue to use backend polling via `flowStatusPoller`
- Backend registration via `postDepositToBackend()` / `postPaymentToBackend()`
- Status queries via `getFlowStatus()` API endpoint

## Files Marked for Removal

### Core Backend Polling Files

1. **`src/services/flow/flowStatusPoller.ts`** (ENTIRE FILE)
   - **Status:** `@deprecated LEGACY_BACKEND_CODE`
   - **Purpose:** Polls backend `/api/flow/${flowId}/status` endpoint
   - **Replacement:** `chainPollingService` + `FlowOrchestrator`
   - **Dependencies:** `getFlowStatus()`, `flowStatusCacheService`

2. **`src/services/flow/flowStatusCacheService.ts`** (ENTIRE FILE)
   - **Status:** Used by `flowStatusPoller`
   - **Purpose:** Caches backend flow status responses
   - **Replacement:** Not needed - frontend polling reads from `pollingState` directly

### Backend Registration Functions

3. **`src/services/deposit/depositService.ts`**
   - **Function:** `postDepositToBackend()`
   - **Status:** `@deprecated LEGACY_BACKEND_CODE`
   - **Purpose:** Registers deposit transactions with backend
   - **Replacement:** `chainPollingService.startDepositPolling()` (called automatically after saving transaction)

4. **`src/services/payment/paymentService.ts`**
   - **Function:** `postPaymentToBackend()`
   - **Status:** `@deprecated LEGACY_BACKEND_CODE`
   - **Purpose:** Registers payment transactions with backend
   - **Replacement:** `chainPollingService.startPaymentPolling()` (called automatically after saving transaction)

5. **`src/services/flow/flowInitiationService.ts`**
   - **Function:** `registerWithBackend()`
   - **Status:** `@deprecated LEGACY_BACKEND_CODE`
   - **Purpose:** Registers flow metadata with backend
   - **Replacement:** Not needed - frontend polling doesn't require backend registration

### Backend API Client Functions

6. **`src/services/api/backendClient.ts`**
   - **Function:** `startFlowTracking()`
   - **Status:** `@deprecated LEGACY_BACKEND_CODE`
   - **Purpose:** POST `/api/track/flow` to register flow
   - **Replacement:** Not needed

   - **Function:** `getFlowStatus()`
   - **Status:** `@deprecated LEGACY_BACKEND_CODE`
   - **Purpose:** GET `/api/flow/${flowId}/status` to query status
   - **Replacement:** `pollingStateManager.getPollingState()`

   - **Function:** `lookupFlowByHash()`
   - **Status:** May be kept for backward compatibility
   - **Purpose:** Lookup flow by transaction hash
   - **Replacement:** Direct transaction lookup by hash

## Migration Checklist

### Phase 1: Enable Frontend Polling (Current)

- [x] Implement frontend polling infrastructure
- [x] Add feature flag `REACT_APP_ENABLE_FRONTEND_POLLING`
- [x] Mark backend code with `@deprecated LEGACY_BACKEND_CODE`
- [x] Create migration guide document
- [ ] Test frontend polling in staging environment
- [ ] Monitor error rates and performance

### Phase 2: Gradual Rollout

- [ ] Enable feature flag for internal testing
- [ ] Enable feature flag for beta users
- [ ] Monitor transaction success rates
- [ ] Compare frontend vs backend polling performance
- [ ] Collect user feedback

### Phase 3: Full Migration

- [ ] Enable feature flag by default (remove flag check)
- [ ] Remove `postDepositToBackend()` calls
- [ ] Remove `postPaymentToBackend()` calls
- [ ] Remove `registerWithBackend()` calls
- [ ] Update `useTxTracker` to only use frontend polling
- [ ] Remove backend polling fallback logic

### Phase 4: Cleanup

- [ ] Delete `src/services/flow/flowStatusPoller.ts`
- [ ] Delete `src/services/flow/flowStatusCacheService.ts`
- [ ] Remove `startFlowTracking()` from `backendClient.ts`
- [ ] Remove `getFlowStatus()` from `backendClient.ts` (or keep for backward compatibility)
- [ ] Remove `flowId` dependency from transaction storage (optional)
- [ ] Remove `flowStatusSnapshot` field from `StoredTransaction` (optional)
- [ ] Update TypeScript types to remove backend-specific fields

## Testing Requirements

### Unit Tests

- [ ] Test `chainPollingService.startDepositPolling()`
- [ ] Test `chainPollingService.startPaymentPolling()`
- [ ] Test `FlowOrchestrator` lifecycle (start, resume, cancel)
- [ ] Test `pollingStateManager` persistence
- [ ] Test error handling and retry logic
- [ ] Test timeout handling (per-chain and global)

### Integration Tests

- [ ] Test full deposit flow (EVM → Noble → Namada)
- [ ] Test full payment flow (Namada → Noble → EVM)
- [ ] Test resume polling after page refresh
- [ ] Test resume polling after app restart
- [ ] Test cancellation and resume
- [ ] Test error recovery
- [ ] Test timeout scenarios

### Manual Testing Checklist

- [ ] Create deposit transaction with frontend polling enabled
- [ ] Verify stages update correctly
- [ ] Refresh page and verify polling resumes
- [ ] Close browser and reopen - verify polling resumes
- [ ] Cancel polling and verify status updates
- [ ] Resume cancelled polling and verify continuation
- [ ] Test with slow/unreliable network connection
- [ ] Test with RPC errors (simulate 429, 500, timeout)
- [ ] Verify error messages are user-friendly
- [ ] Verify retry logic works correctly

## Backward Compatibility

### Legacy Transactions

Transactions created before frontend polling migration will have:
- `flowId` field (backend flow ID)
- `flowStatusSnapshot` field (cached backend status)
- `clientStages` array (client-side stages)

These transactions will continue to work with backend polling until they complete or timeout.

### Migration Strategy

1. **New Transactions:** Use frontend polling (when feature flag enabled)
2. **Legacy Transactions:** Continue using backend polling
3. **Hybrid Period:** Both systems run in parallel
4. **Cleanup:** After all legacy transactions complete, remove backend code

## Rollback Plan

If issues are discovered during migration:

1. **Disable Feature Flag:**
   ```bash
   VITE_ENABLE_FRONTEND_POLLING=false
   ```

2. **Revert Code Changes:**
   - Restore `postDepositToBackend()` calls
   - Restore `postPaymentToBackend()` calls
   - Restore backend polling in `useTxTracker`

3. **Monitor:**
   - Check error logs
   - Verify transaction completion rates
   - Collect user feedback

## Performance Considerations

### Frontend Polling Benefits

- **Reduced Backend Load:** No backend polling jobs
- **Lower Latency:** Direct RPC queries (no backend round-trip)
- **Better UX:** Real-time status updates
- **Resumability:** Works offline/after refresh

### Frontend Polling Considerations

- **RPC Rate Limits:** May hit RPC provider limits (handled with retry logic)
- **Browser Resources:** Polling consumes browser resources (handled with page visibility API)
- **Network Dependency:** Requires stable RPC connections (handled with error recovery)

## Monitoring

### Key Metrics

- Transaction completion rate
- Average polling duration
- Error rates (by error type)
- Timeout rates
- Resume success rate
- RPC call success rate

### Logging

Frontend polling logs:
- `[FlowOrchestrator]` - Flow orchestration events
- `[EvmPoller]` - EVM chain polling
- `[NoblePoller]` - Noble chain polling
- `[NamadaPoller]` - Namada chain polling
- `[ChainPollingService]` - Service-level events

## Support

For questions or issues during migration:
1. Check logs for error details
2. Verify feature flag is set correctly
3. Check RPC endpoint availability
4. Review error recovery strategies
5. Contact development team

## References

- **Frontend Polling Service:** `src/services/polling/chainPollingService.ts`
- **Flow Orchestrator:** `src/services/polling/flowOrchestrator.ts`
- **Polling State Manager:** `src/services/polling/pollingStateManager.ts`
- **Feature Flag:** `VITE_ENABLE_FRONTEND_POLLING`
- **Migration Plan:** `.cursor/scratchpad.md`

