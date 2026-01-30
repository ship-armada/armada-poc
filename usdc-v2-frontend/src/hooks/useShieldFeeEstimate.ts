/**
 * Shield Fee Estimate Hook
 *
 * Provides debounced fee estimation for shield transactions.
 */

import { useState, useEffect, useCallback } from 'react'
import { estimateShieldFee, type ShieldFeeEstimate } from '@/services/shield'
import { parseUSDC } from '@/lib/sdk'

// ============ Types ============

export interface UseShieldFeeEstimateState {
  /** Fee estimate if available */
  feeInfo: ShieldFeeEstimate | null
  /** Whether fee is being estimated */
  isLoading: boolean
  /** Error message if estimation failed */
  error: string | null
}

export interface UseShieldFeeEstimateReturn extends UseShieldFeeEstimateState {
  /** Manually refresh the estimate */
  refresh: () => void
}

// ============ Hook ============

/**
 * Estimate fees for a shield transaction with debouncing
 *
 * @param evmAddress - Address to estimate for
 * @param amount - Amount in human readable format (e.g., "100.50")
 * @param debounceMs - Debounce delay in milliseconds (default 500)
 */
export function useShieldFeeEstimate(
  evmAddress: string | undefined,
  amount: string,
  debounceMs: number = 500,
): UseShieldFeeEstimateReturn {
  const [state, setState] = useState<UseShieldFeeEstimateState>({
    feeInfo: null,
    isLoading: false,
    error: null,
  })

  const [refreshCounter, setRefreshCounter] = useState(0)

  // Parse amount to bigint
  const amountRaw = amount.trim() ? parseUSDC(amount) : 0n

  // Estimate fees with debounce
  useEffect(() => {
    // Skip if no address or amount
    if (!evmAddress || amountRaw <= 0n) {
      setState({
        feeInfo: null,
        isLoading: false,
        error: null,
      })
      return
    }

    let cancelled = false

    // Debounce the estimation
    const timeoutId = setTimeout(async () => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }))

      try {
        const estimate = await estimateShieldFee(evmAddress, amountRaw)

        if (!cancelled) {
          setState({
            feeInfo: estimate,
            isLoading: false,
            error: null,
          })
        }
      } catch (err) {
        console.error('[fee-estimate] Failed to estimate shield fee:', err)
        if (!cancelled) {
          setState({
            feeInfo: null,
            isLoading: false,
            error: err instanceof Error ? err.message : 'Failed to estimate fee',
          })
        }
      }
    }, debounceMs)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [evmAddress, amountRaw, debounceMs, refreshCounter])

  // Manual refresh
  const refresh = useCallback(() => {
    setRefreshCounter((c) => c + 1)
  }, [])

  return {
    ...state,
    refresh,
  }
}
