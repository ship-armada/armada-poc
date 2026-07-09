/**
 * Generic hook for fee estimation with consistent state management and error handling
 */

import { useState, useEffect } from 'react'
import { logger } from '@/utils/logger'

export interface FeeEstimateState<TFeeInfo> {
  feeInfo: TFeeInfo | null
  isLoading: boolean
  error: string | null
}

export interface UseFeeEstimateOptions<TFeeInfo> {
  /** Function to estimate fees */
  estimator: () => Promise<TFeeInfo>
  /** Whether fee estimation is enabled */
  enabled?: boolean
  /** Custom validation function to check if estimation should run */
  validate?: () => boolean
  /** Log context for debugging (e.g., 'deposit', 'payment', 'shielding') */
  logContext?: string
  /** Additional dependencies that should trigger re-estimation */
  dependencies?: unknown[]
}

/**
 * Generic hook for fee estimation
 * 
 * @param options - Fee estimation configuration
 * @returns Fee estimation state
 */
export function useFeeEstimate<TFeeInfo>(
  options: UseFeeEstimateOptions<TFeeInfo>
): FeeEstimateState<TFeeInfo> {
  const {
    estimator,
    enabled = true,
    validate,
    logContext = 'fee',
    dependencies = [],
  } = options

  const [state, setState] = useState<FeeEstimateState<TFeeInfo>>({
    feeInfo: null,
    isLoading: false,
    error: null,
  })

  useEffect(() => {
    // Check if estimation is enabled
    if (!enabled) {
      setState({
        feeInfo: null,
        isLoading: false,
        error: null,
      })
      return
    }

    // Run custom validation if provided
    if (validate && !validate()) {
      setState({
        feeInfo: null,
        isLoading: false,
        error: null,
      })
      return
    }

    const estimateFee = async () => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }))

      try {
        logger.debug(`[useFeeEstimate:${logContext}] Estimating fee`)

        const feeInfo = await estimator()

        logger.debug(`[useFeeEstimate:${logContext}] Fee estimated successfully`)

        setState({
          feeInfo,
          isLoading: false,
          error: null,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to estimate fee'
        logger.warn(`[useFeeEstimate:${logContext}] Fee estimation failed`, {
          error: errorMessage,
        })

        setState({
          feeInfo: null,
          isLoading: false,
          error: errorMessage,
        })
      }
    }

    void estimateFee()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...dependencies])

  return state
}

