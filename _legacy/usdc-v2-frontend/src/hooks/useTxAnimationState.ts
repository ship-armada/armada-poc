import { useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { transactionStorageService } from '@/services/tx/transactionStorageService'
import { isInProgress, isCompleted } from '@/services/tx/transactionStatusService'
import { txAnimationAtom, type TxAnimationPhase } from '@/atoms/txAnimationAtom'

const FADE_OUT_DURATION = 500
const FADE_IN_DURATION = 500

export function useTxAnimationState() {
  const setAnimationMap = useSetAtom(txAnimationAtom)
  const animationMapRef = useRef<Map<string, { phase: TxAnimationPhase; phaseStartedAt: number }>>(new Map())
  
  useEffect(() => {
    const updateAnimationStates = () => {
      const allTxs = transactionStorageService.getAllTransactions()
      const updated = new Map(animationMapRef.current)
      const now = Date.now()
      
      allTxs.forEach(tx => {
        const currentState = updated.get(tx.id)
        const isInProgressStatus = isInProgress(tx)
        const isCompletedStatus = isCompleted(tx)
        
        // Determine target phase based on transaction status
        let targetPhase: TxAnimationPhase | null = null
        
        if (isInProgressStatus) {
          targetPhase = 'inProgress'
        } else if (isCompletedStatus) {
          // If no current state, transaction was already completed on initial load - skip animation
          if (!currentState) {
            targetPhase = 'inHistory'
          }
          // If transitioning from in-progress to completed, start exit animation
          else if (currentState.phase === 'inProgress') {
            targetPhase = 'exitingInProgress'
          } else if (currentState.phase === 'exitingInProgress') {
            const elapsed = now - currentState.phaseStartedAt
            if (elapsed >= FADE_OUT_DURATION) {
              // Transition to enteringHistory - ensure it's observable for at least one render cycle
              // Set phaseStartedAt to now to ensure Framer Motion sees the phase change
              targetPhase = 'enteringHistory'
            } else {
              targetPhase = 'exitingInProgress' // Keep exiting
            }
          } else if (currentState.phase === 'enteringHistory') {
            const elapsed = now - currentState.phaseStartedAt
            // Ensure enteringHistory lasts at least 50ms to guarantee it's observable by Framer Motion
            // This prevents same-tick promotion that would skip the animation
            const minDuration = 50
            if (elapsed >= FADE_IN_DURATION && elapsed >= minDuration) {
              targetPhase = 'inHistory'
            } else {
              targetPhase = 'enteringHistory' // Keep entering - ensure phase is observable
            }
          } else {
            targetPhase = 'inHistory'
          }
        }
        
        // Update state if phase changed
        if (targetPhase && targetPhase !== currentState?.phase) {
          updated.set(tx.id, {
            phase: targetPhase,
            phaseStartedAt: now,
          })
        } else if (targetPhase && currentState) {
          // Keep existing state but update the map reference
          updated.set(tx.id, currentState)
        }
      })
      
      // Clean up states for transactions that no longer exist
      const existingTxIds = new Set(allTxs.map(tx => tx.id))
      Array.from(updated.keys()).forEach(txId => {
        if (!existingTxIds.has(txId)) {
          updated.delete(txId)
        }
      })
      
      // Only update if there are actual changes
      let hasChanges = updated.size !== animationMapRef.current.size
      if (!hasChanges) {
        hasChanges = Array.from(updated.entries()).some(([id, state]) => {
          const oldState = animationMapRef.current.get(id)
          return oldState?.phase !== state.phase || oldState?.phaseStartedAt !== state.phaseStartedAt
        })
      }
      
      if (hasChanges) {
        animationMapRef.current = updated
        setAnimationMap(updated)
      }
    }
    
    // Update immediately
    updateAnimationStates()
    
    // Update periodically (less frequent than current 10ms - 100ms should be sufficient)
    const interval = setInterval(updateAnimationStates, 100)
    return () => clearInterval(interval)
  }, [setAnimationMap])
}

