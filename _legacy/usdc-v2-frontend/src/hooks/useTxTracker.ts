import { useCallback, useEffect, useRef } from 'react'
import { useAtom } from 'jotai'
import { txAtom } from '@/atoms/txAtom'
import type { TrackedTransaction, TxStatusMessage } from '@/types/tx'
import { transactionStorageService, type StoredTransaction } from '@/services/tx/transactionStorageService'
import { logger } from '@/utils/logger'

export function useTxTracker(options?: { enablePolling?: boolean }) {
  const { enablePolling = true } = options || {}
  logger.debug('[useTxTracker] Hook called', { enablePolling })
  const [txState, setTxState] = useAtom(txAtom)
  const hasStartedInitialPolling = useRef(false)
  const polledTransactionIds = useRef(new Set<string>())
  const cleanupFunctionsRef = useRef<Array<() => void>>([])

  // Hydrate transaction state from localStorage on mount
  useEffect(() => {
    logger.debug('[useTxTracker] Starting hydration effect')
    try {
      const storedTxs = transactionStorageService.getAllTransactions()
      
      if (storedTxs.length === 0) {
        logger.debug('[useTxTracker] No stored transactions found')
        return
      }

      logger.info('[useTxTracker] Hydrating transactions from storage', {
        count: storedTxs.length,
      })

      // Use stored transactions as-is (no backend status syncing needed)
      const syncedTxs: StoredTransaction[] = storedTxs

      // Convert StoredTransaction[] to TrackedTransaction[] for history
      // (StoredTransaction extends TrackedTransaction, so this is safe)
      const history: TrackedTransaction[] = syncedTxs.map((stored) => ({
        id: stored.id,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        chain: stored.chain,
        direction: stored.direction,
        status: stored.status,
        hash: stored.hash,
        errorMessage: stored.errorMessage,
        flowMetadata: stored.flowMetadata,
      }))

      // Note: activeTransaction concept is deprecated - all in-progress transactions are polled in parallel
      // Keeping it for backward compatibility but it's no longer the primary mechanism
      const inProgressTxs = transactionStorageService.getInProgressTransactions()
      const activeTx = inProgressTxs.length > 0 ? inProgressTxs[0] : undefined

      setTxState({
        activeTransaction: activeTx,
        history,
      })

      logger.info('[useTxTracker] Transactions hydrated successfully', {
        totalCount: history.length,
        activeTransactionId: activeTx?.id,
        inProgressCount: inProgressTxs.length,
      })
    } catch (error) {
      logger.error('[useTxTracker] Failed to hydrate transactions', {
        error: error instanceof Error ? error.message : String(error),
      })
      // Don't throw - allow app to continue without hydrated transactions
    }
  }, [setTxState]) // Only run once on mount

  const applyStatusMessage = useCallback(
    (message: TxStatusMessage) => {
      // CRITICAL: Update storage FIRST (same pattern as onStatusUpdate and refreshFlowStatus)
      // Get current transaction from storage to merge updates safely
      const currentTx = transactionStorageService.getTransaction(message.txId)
      if (!currentTx) {
        logger.warn('[useTxTracker] Transaction not found in storage for applyStatusMessage', {
          txId: message.txId,
          stage: message.stage,
        })
        return
      }

      // Only clear error message when:
      // 1. Status changes to 'finalized' (success)
      // 2. Status changes from 'error' to a non-error state
      // Otherwise, preserve the error message
      const shouldClearError = 
        message.stage === 'finalized' || 
        (currentTx.status === 'error' && message.stage !== 'error')

      const updated: StoredTransaction = {
        ...currentTx,
        status: message.stage,
        errorMessage: shouldClearError ? undefined : currentTx.errorMessage,
        updatedAt: Date.now(),
      }

      // Atomic storage update (happens before state update)
      try {
        transactionStorageService.saveTransaction(updated)
        logger.debug('[useTxTracker] Storage updated via applyStatusMessage', {
          txId: message.txId,
          stage: message.stage,
          summary: message.summary,
        })
      } catch (error) {
        logger.error('[useTxTracker] Failed to save transaction to storage in applyStatusMessage', {
          txId: message.txId,
          stage: message.stage,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }

      // Then update state atom (function updater ensures safe concurrent updates)
      setTxState((state) => ({
        ...state,
        activeTransaction:
          state.activeTransaction && state.activeTransaction.id === message.txId
            ? { 
                ...state.activeTransaction, 
                status: message.stage, 
                errorMessage: shouldClearError ? undefined : state.activeTransaction.errorMessage, 
                updatedAt: Date.now() 
              }
            : state.activeTransaction,
        history: state.history.map((tx) =>
          tx.id === message.txId
            ? { 
                ...tx, 
                status: message.stage, 
                errorMessage: shouldClearError ? undefined : tx.errorMessage, 
                updatedAt: Date.now() 
              }
            : tx,
        ),
      }))
    },
    [setTxState],
  )

  // refreshFlowStatus removed - backend polling no longer used
  // Frontend polling handles all status updates via orchestrator
  const refreshFlowStatus = useCallback(
    async (_flowId: string) => {
      logger.debug('[useTxTracker] refreshFlowStatus called but backend polling is disabled', {
        flowId: _flowId,
      })
    },
    [],
  )

  // Helper function to cleanup stale polling state
  // Detects transactions where retry was started (pending flowStatus) but page was refreshed (no orchestrator)
  // Sets them to 'cancelled' to fix GUI desync and show retry button
  const cleanupStalePollingState = useCallback(async () => {
    const { getOrchestrator } = await import('@/services/polling/orchestratorRegistry')
    const allTxs = transactionStorageService.getAllTransactions()
    
    let cleanedCount = 0
    
    for (const tx of allTxs) {
      if (!tx.pollingState) continue
      
      // Detect stale state: pending flowStatus but no active orchestrator
      const hasActiveOrchestrator = !!getOrchestrator(tx.id)
      const isPending = tx.pollingState.flowStatus === 'pending'
      const isUndetermined = tx.status === 'undetermined'
      
      // Stale state: retry was started (pending) but page refreshed (no orchestrator)
      if (isPending && !hasActiveOrchestrator && isUndetermined) {
        logger.info('[useTxTracker] Cleaning up stale polling state', {
          txId: tx.id,
          previousFlowStatus: tx.pollingState.flowStatus,
        })
        
        // Set to cancelled (user effectively cancelled by refreshing)
        transactionStorageService.updateTransaction(tx.id, {
          pollingState: {
            ...tx.pollingState,
            flowStatus: 'cancelled',
          }
        })
        
        cleanedCount++
      }
    }
    
    if (cleanedCount > 0) {
      logger.info('[useTxTracker] Cleaned up stale polling states', {
        count: cleanedCount,
      })
    }
  }, [])

  // Helper function to start polling for in-progress transactions
  const startPollingForTransactions = useCallback(async () => {
    logger.debug('[useTxTracker] startPollingForTransactions called', {
      hasStartedInitialPolling: hasStartedInitialPolling.current,
      alreadyPolledTxIds: Array.from(polledTransactionIds.current),
    })

    const inProgressTxs = transactionStorageService.getInProgressTransactions()
    logger.debug('[useTxTracker] Found in-progress transactions from storage', {
      count: inProgressTxs.length,
      transactions: inProgressTxs.map((tx) => ({
        id: tx.id,
        status: tx.status,
        hasPollingState: !!tx.pollingState,
        chain: tx.chain,
        direction: tx.direction,
      })),
    })

    // Import resumePolling function
    const { resumePolling } = await import('@/services/polling/chainPollingService')

    // Filter transactions to only frontend-managed (with pollingState)
    const frontendTxs: StoredTransaction[] = []

    for (const tx of inProgressTxs) {
      const hasPollingState = !!tx.pollingState
      const hasBeenPolled = polledTransactionIds.current.has(tx.id)

      // Frontend-managed: has pollingState and hasn't been polled yet
      if (hasPollingState && !hasBeenPolled) {
        frontendTxs.push(tx)
      } else {
        logger.debug('[useTxTracker] Transaction filtered out', {
          txId: tx.id,
          status: tx.status,
          hasPollingState,
          hasBeenPolled,
          reason: !hasPollingState
            ? 'missing pollingState'
            : hasBeenPolled
            ? 'already polled'
            : 'unknown',
        })
      }
    }

    logger.info('[useTxTracker] Filtered transactions for frontend polling', {
      frontendCount: frontendTxs.length,
    })

    // Resume frontend polling for transactions with pollingState
    for (const tx of frontendTxs) {
      logger.info('[useTxTracker] Resuming frontend polling for transaction', {
        txId: tx.id,
        flowType: tx.pollingState?.flowType,
        flowStatus: tx.pollingState?.flowStatus,
        latestCompletedStage: tx.pollingState?.latestCompletedStage,
      })

      try {
        await resumePolling(tx.id)
        polledTransactionIds.current.add(tx.id) // Mark as polled
      } catch (error) {
        logger.error('[useTxTracker] Failed to resume frontend polling', {
          txId: tx.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (frontendTxs.length === 0) {
      logger.info('[useTxTracker] No frontend transactions found for polling', {
        inProgressCount: inProgressTxs.length,
        frontendCount: frontendTxs.length,
      })
      return []
    }

    const isInitialPolling = !hasStartedInitialPolling.current
    if (isInitialPolling) {
      logger.info('[useTxTracker] Starting initial polling for in-progress transactions on app startup', {
        count: frontendTxs.length,
        txIds: frontendTxs.map((tx) => tx.id),
      })
      hasStartedInitialPolling.current = true
    } else {
      logger.info('[useTxTracker] Starting polling for in-progress transactions', {
        count: frontendTxs.length,
        txIds: frontendTxs.map((tx) => tx.id),
      })
    }

    // Frontend polling is handled by resumePolling above, no cleanup needed
    return []
  }, [])

  const upsertTransaction = useCallback(
    (input: TrackedTransaction) => {
      setTxState((state) => {
        const history = state.history.filter((item) => item.id !== input.id)
        // Ensure updatedAt is set when upserting
        const updatedTx: TrackedTransaction = {
          ...input,
          updatedAt: Date.now(),
        }
        
        // Also save to unified storage
        try {
          transactionStorageService.saveTransaction(updatedTx as any) // Cast to StoredTransaction (will have additional fields)
        } catch (error) {
          logger.warn('[useTxTracker] Failed to save transaction to storage', {
            txId: updatedTx.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        
        return { ...state, activeTransaction: updatedTx, history: [updatedTx, ...history] }
      })

      // Start polling for new transactions if they have a flowId
      // NOTE: We don't check enablePolling here because polling is managed globally by the App-level hook instance.
      // Page-level hooks (like Deposit/SendPayment) disable polling to avoid duplicate effects, but transactions
      // should still start polling when submitted. The global polling instance will handle the actual polling.
      // Frontend polling is handled automatically by chainPollingService when transactions are saved
      // No need to manually start polling here
    },
    [setTxState],
  )

  // Poll in-progress transactions that haven't been polled yet
  // This effect runs:
  // 1. On mount (to resume polling for in-progress transactions after page refresh)
  // 2. When enablePolling changes
  // 
  // IMPORTANT: We do NOT depend on txState.history because:
  // - Status updates change history, causing unnecessary re-runs
  // - startPollingForTransactions reads directly from storage (source of truth)
  // - Duplicate prevention is handled by polledTransactionIds ref
  // - New transactions added via upsertTransaction will be picked up on next mount/refresh
  useEffect(() => {
    if (!enablePolling) {
      logger.debug('[useTxTracker] Polling disabled for this hook instance')
      // Clear any existing cleanup functions
      cleanupFunctionsRef.current = []
      return
    }

    logger.debug('[useTxTracker] Polling effect triggered', {
      hasStartedInitialPolling: hasStartedInitialPolling.current,
      alreadyPolledTxIds: Array.from(polledTransactionIds.current),
    })

    // Reset cleanup functions for this effect run
    cleanupFunctionsRef.current = []

    // Cleanup stale polling states first (before starting new polling)
    // Then start polling for in-progress transactions
    Promise.resolve()
      .then(() => cleanupStalePollingState())
      .catch((error) => {
        logger.error('[useTxTracker] Failed to cleanup stale polling state', {
          error: error instanceof Error ? error.message : String(error),
        })
        // Continue even if cleanup fails
      })
      .then(() => startPollingForTransactions())
      .then((functions) => {
        cleanupFunctionsRef.current = functions || []
        logger.debug('[useTxTracker] Polling effect completed', {
          cleanupFunctionsCount: cleanupFunctionsRef.current.length,
        })
      })
      .catch((error) => {
        logger.error('[useTxTracker] Failed to start polling', {
          error: error instanceof Error ? error.message : String(error),
        })
        cleanupFunctionsRef.current = []
      })

    // Cleanup: stop all polling jobs on unmount or when enablePolling changes
    return () => {
      const cleanupFunctions = cleanupFunctionsRef.current
      if (!Array.isArray(cleanupFunctions)) {
        logger.warn('[useTxTracker] Cleanup functions is not an array, skipping cleanup', {
          type: typeof cleanupFunctions,
        })
        return
      }

      logger.debug('[useTxTracker] Cleaning up polling jobs', {
        count: cleanupFunctions.length,
      })
      for (const cleanup of cleanupFunctions) {
        if (typeof cleanup === 'function') {
          try {
        cleanup()
          } catch (error) {
            logger.error('[useTxTracker] Error during cleanup', {
              error: error instanceof Error ? error.message : String(error),
            })
      }
        }
      }
      // Clear cleanup functions after running them
      cleanupFunctionsRef.current = []
    }
  }, [enablePolling, startPollingForTransactions, cleanupStalePollingState]) // Removed txState.history dependency to prevent re-runs on status updates
  // Note: This effect reads directly from storage to resume polling for in-progress transactions

  const clearActive = useCallback(() => {
    // Frontend polling cleanup is handled by chainPollingService
    setTxState((state) => ({ ...state, activeTransaction: undefined }))
  }, [setTxState])

  /**
   * Re-poll an undetermined transaction.
   * This is a stub/hook for future implementation.
   * 
   * TODO: Implement re-polling functionality for undetermined transactions.
   * This should:
   * 1. Check if transaction has flowId (can't poll without it)
   * 2. Reset status from 'undetermined' to 'submitting' or 'broadcasted'
   * 3. Start polling with appropriate timeout
   * 4. Update storage and state accordingly
   * 
   * @param txId - Transaction ID to re-poll
   */
  const retryPollingUndetermined = useCallback(
    async (txId: string): Promise<void> => {
      logger.info('[useTxTracker] Retry polling requested for undetermined transaction', { txId })
      
      const tx = transactionStorageService.getTransaction(txId)
      if (!tx) {
        logger.warn('[useTxTracker] Transaction not found for retry', { txId })
        return
      }

      if (tx.status !== 'undetermined') {
        logger.warn('[useTxTracker] Transaction is not undetermined, cannot retry', {
          txId,
          status: tx.status,
        })
        return
      }

      // TODO: Implement re-polling logic
      // For now, just log that this feature is not yet implemented
      logger.info('[useTxTracker] Re-polling functionality not yet implemented', {
        txId,
        chain: tx.chain,
        direction: tx.direction,
      })

      // Stub: This will be implemented in a future task
      // The implementation should:
      // 1. Reset transaction status to appropriate in-progress state
      // 2. Start polling with timeout
      // 3. Update storage and state
    },
    [],
  )

  return {
    state: txState,
    upsertTransaction,
    applyStatusMessage,
    clearActive,
    refreshFlowStatus,
    retryPollingUndetermined, // Expose re-polling hook
  }
}
