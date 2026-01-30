/**
 * Base Poller Class
 * 
 * Provides common functionality for all chain pollers:
 * - DRY error handling
 * - Retry logic with exponential backoff
 * - Timeout handling
 * - Abort signal checking
 */

import type { ChainPollResult } from './types'
import { logger } from '@/utils/logger'

/**
 * Sleep utility with abort signal support
 */
export function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Polling cancelled'))
      return
    }

    const timeoutId = setTimeout(() => {
      resolve()
    }, ms)

    // Listen for abort signal
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        clearTimeout(timeoutId)
        reject(new Error('Polling cancelled'))
      })
    }
  })
}

/**
 * Check if error is transient (should retry)
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false

  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorCode = (error as { code?: string }).code
  const statusCode = (error as { status?: number }).status
  const response = (error as { response?: { status?: number } }).response

  // HTTP status codes that indicate transient errors
  const httpStatus = statusCode || response?.status
  if (httpStatus === 429 || httpStatus === 503 || httpStatus === 502 || httpStatus === 504) {
    return true
  }

  // Network errors
  if (
    errorCode === 'ECONNRESET' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'ENOTFOUND' ||
    errorCode === 'ECONNREFUSED' ||
    errorCode === 'EAI_AGAIN'
  ) {
    return true
  }

  // Rate limiting (various formats)
  if (
    errorMessage.toLowerCase().includes('rate limit') ||
    errorMessage.toLowerCase().includes('too many requests') ||
    errorMessage.toLowerCase().includes('429')
  ) {
    return true
  }

  // Timeout errors
  if (
    errorMessage.toLowerCase().includes('timeout') ||
    errorMessage.toLowerCase().includes('timed out') ||
    errorMessage.toLowerCase().includes('deadline exceeded')
  ) {
    return true
  }

  // Connection errors
  if (
    errorMessage.toLowerCase().includes('connection') ||
    errorMessage.toLowerCase().includes('network') ||
    errorMessage.toLowerCase().includes('fetch failed')
  ) {
    return true
  }

  return false
}

/**
 * Check if error is permanent (should not retry)
 */
export function isPermanentError(error: unknown): boolean {
  if (!error) return false

  const errorMessage = error instanceof Error ? error.message : String(error)
  const statusCode = (error as { status?: number }).status
  const response = (error as { response?: { status?: number } }).response

  // HTTP status codes that indicate permanent errors
  const httpStatus = statusCode || response?.status
  if (httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
    return true
  }

  // Invalid request errors
  if (
    errorMessage.toLowerCase().includes('invalid') ||
    errorMessage.toLowerCase().includes('bad request') ||
    errorMessage.toLowerCase().includes('malformed') ||
    errorMessage.toLowerCase().includes('parse error')
  ) {
    return true
  }

  // Authentication/authorization errors
  if (
    errorMessage.toLowerCase().includes('unauthorized') ||
    errorMessage.toLowerCase().includes('forbidden') ||
    errorMessage.toLowerCase().includes('authentication')
  ) {
    return true
  }

  return false
}

/**
 * Extract error code from error object
 */
export function extractErrorCode(error: unknown): string | number | undefined {
  if (!error) return undefined

  const statusCode = (error as { status?: number }).status
  const response = (error as { response?: { status?: number } }).response
  const code = (error as { code?: string | number }).code

  if (statusCode) return statusCode
  if (response?.status) return response.status
  if (code) return code

  return undefined
}

/**
 * Classify error as network error or RPC error
 * 
 * @param error - Error object to classify
 * @returns Error category: 'network', 'rpc', or 'unknown'
 */
export function classifyErrorCategory(error: unknown): 'network' | 'rpc' | 'unknown' {
  if (!error) return 'unknown'

  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorCode = (error as { code?: string }).code
  const statusCode = (error as { status?: number }).status
  const response = (error as { response?: { status?: number } }).response

  // Network-level errors (connection issues)
  if (
    errorCode === 'ECONNRESET' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'ENOTFOUND' ||
    errorCode === 'ECONNREFUSED' ||
    errorCode === 'EAI_AGAIN' ||
    errorMessage.toLowerCase().includes('network') ||
    errorMessage.toLowerCase().includes('connection') ||
    errorMessage.toLowerCase().includes('fetch failed') ||
    errorMessage.toLowerCase().includes('networkerror') ||
    errorMessage.toLowerCase().includes('failed to fetch')
  ) {
    return 'network'
  }

  // RPC-level errors (server-side errors)
  const httpStatus = statusCode || response?.status
  if (
    httpStatus ||
    errorMessage.toLowerCase().includes('rpc') ||
    errorMessage.toLowerCase().includes('json-rpc') ||
    errorMessage.toLowerCase().includes('method not found') ||
    errorMessage.toLowerCase().includes('invalid params') ||
    errorMessage.toLowerCase().includes('execution reverted') ||
    errorMessage.toLowerCase().includes('revert')
  ) {
    return 'rpc'
  }

  return 'unknown'
}

/**
 * Determine if error is recoverable and suggest recovery action
 * 
 * @param error - Error object to analyze
 * @returns Recovery information
 */
export function determineRecoveryStrategy(error: unknown): {
  isRecoverable: boolean
  recoveryAction: 'retry' | 'check_connection' | 'check_rpc_status' | 'contact_support' | 'none'
} {
  if (!error) {
    return { isRecoverable: false, recoveryAction: 'none' }
  }

  const errorCategory = classifyErrorCategory(error)
  const isTransient = isTransientError(error)
  const isPermanent = isPermanentError(error)
  const statusCode = (error as { status?: number }).status ||
    (error as { response?: { status?: number } }).response?.status

  // Network errors are usually recoverable
  if (errorCategory === 'network' && isTransient) {
    return { isRecoverable: true, recoveryAction: 'check_connection' }
  }

  // Rate limiting (429) - retry after delay
  if (statusCode === 429 || isTransient) {
    return { isRecoverable: true, recoveryAction: 'retry' }
  }

  // Server errors (5xx) - check RPC status
  if (statusCode && statusCode >= 500) {
    return { isRecoverable: true, recoveryAction: 'check_rpc_status' }
  }

  // Permanent errors - not recoverable
  if (isPermanent) {
    return { isRecoverable: false, recoveryAction: 'contact_support' }
  }

  // Unknown errors - suggest checking connection
  if (errorCategory === 'unknown') {
    return { isRecoverable: true, recoveryAction: 'check_connection' }
  }

  // Default: not recoverable
  return { isRecoverable: false, recoveryAction: 'none' }
}

/**
 * Format error message with context
 */
export function formatErrorMessage(error: unknown, context?: Record<string, unknown>): string {
  if (!error) return 'Unknown error'

  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorCode = extractErrorCode(error)
  const contextStr = context ? ` (${JSON.stringify(context)})` : ''

  if (errorCode) {
    return `${errorMessage} [Code: ${errorCode}]${contextStr}`
  }

  return `${errorMessage}${contextStr}`
}

/**
 * Retry a function with exponential backoff
 * 
 * @param fn - Function to retry
 * @param maxRetries - Maximum number of retries
 * @param initialDelayMs - Initial delay before first retry
 * @param maxDelayMs - Maximum delay between retries
 * @param abortSignal - Optional abort signal
 * @returns Result of function call
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 500,
  maxDelayMs: number = 5000,
  abortSignal?: AbortSignal,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check abort signal at start of each retry attempt
    if (abortSignal?.aborted) {
      logger.info('[BasePoller] Abort signal detected at start of retry attempt, stopping', {
        attempt,
        maxRetries,
        abortSignalAborted: abortSignal.aborted,
      })
      throw new Error('Polling cancelled')
    }

    try {
      return await fn()
    } catch (error) {
      // CRITICAL: Check abort signal IMMEDIATELY after error - before any retry decision
      // This ensures we stop immediately if cancellation happened during the request
      if (abortSignal?.aborted) {
        logger.info('[BasePoller] Abort signal detected after error (CRITICAL CHECKPOINT), not retrying', {
          attempt,
          maxRetries,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : 'N/A',
          abortSignalAborted: abortSignal.aborted,
        })
        throw new Error('Polling cancelled')
      }

      // Check if error is due to abort (AbortError from fetch or DOMException)
      const isAbortError = 
        (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.message === 'Polling cancelled') ||
        (error instanceof Error && error.message.includes('cancelled'))

      if (isAbortError) {
        logger.debug('[BasePoller] Request was aborted', {
          attempt,
          maxRetries,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        throw new Error('Polling cancelled')
      }

      lastError = error

      // Don't retry permanent errors
      if (isPermanentError(error)) {
        logger.debug('[BasePoller] Permanent error, not retrying', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }

      // Don't retry if max retries reached
      if (attempt >= maxRetries) {
        logger.debug('[BasePoller] Max retries reached', {
          attempt,
          maxRetries,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }

      // Don't retry if not transient error
      if (!isTransientError(error)) {
        logger.debug('[BasePoller] Non-transient error, not retrying', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }

      // Calculate delay with exponential backoff
      const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs)

      // Check abort signal BEFORE deciding to retry
      if (abortSignal?.aborted) {
        logger.debug('[BasePoller] Abort signal detected before retry delay, stopping', {
          attempt,
          maxRetries,
          wouldRetry: attempt < maxRetries,
        })
        throw new Error('Polling cancelled')
      }

      logger.debug('[BasePoller] Retrying after error', {
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
        abortSignalAborted: abortSignal?.aborted,
      })

      // Check abort signal before sleeping
      if (abortSignal?.aborted) {
        logger.debug('[BasePoller] Abort signal detected before sleep, stopping', {
          attempt,
        })
        throw new Error('Polling cancelled')
      }

      try {
        await sleep(delayMs, abortSignal)
      } catch (sleepError) {
        // If sleep was aborted, throw cancellation error
        if (sleepError instanceof Error && sleepError.message === 'Polling cancelled') {
          logger.debug('[BasePoller] Sleep was aborted, stopping retry', {
            attempt,
          })
          throw sleepError
        }
        // Otherwise, continue with retry
      }

      // Check abort signal after sleep (in case it was aborted during sleep)
      if (abortSignal?.aborted) {
        logger.debug('[BasePoller] Abort signal detected after sleep, stopping', {
          attempt,
        })
        throw new Error('Polling cancelled')
      }
    }
  }

  throw lastError
}

/**
 * Create a polling timeout controller
 * 
 * @param timeoutMs - Timeout in milliseconds
 * @param flowId - Flow ID for logging
 * @param abortSignal - Optional external abort signal
 * @returns Timeout controller with cleanup function
 */
export function createPollTimeout(
  timeoutMs: number,
  flowId: string,
  _abortSignal?: AbortSignal,
): { controller: AbortController; cleanup: () => void; wasTimeout: () => boolean } {
  const controller = new AbortController()
  let timeoutOccurred = false

  const timeout = setTimeout(() => {
    timeoutOccurred = true
    logger.warn('[BasePoller] Polling timeout reached', {
      flowId,
      timeoutMs,
    })
    controller.abort()
  }, timeoutMs)

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeout)
    },
    wasTimeout: () => timeoutOccurred,
  }
}

/**
 * Check if operation should be aborted
 * 
 * @param abortSignal - Abort signal to check
 * @returns True if aborted
 */
export function isAborted(abortSignal?: AbortSignal): boolean {
  return abortSignal?.aborted ?? false
}

/**
 * Create a standardized error result
 * 
 * @param type - Error type
 * @param message - Error message
 * @param error - Optional original error object for extracting additional details
 * @param context - Optional context for error message
 * @returns ChainPollResult with error
 */
export function createErrorResult(
  type: 'tx_error' | 'polling_error' | 'polling_timeout' | 'user_action_required',
  message: string,
  error?: unknown,
  context?: Record<string, unknown>,
): ChainPollResult {
  const errorCode = error ? extractErrorCode(error) : undefined
  const formattedMessage = formatErrorMessage(error || message, context)
  const errorCategory = error ? classifyErrorCategory(error) : undefined
  const recoveryStrategy = error ? determineRecoveryStrategy(error) : undefined

  return {
    success: false,
    found: false,
    metadata: {},
    error: {
      type,
      message: formattedMessage,
      occurredAt: Date.now(),
      ...(errorCode && { code: errorCode }),
      ...(errorCategory && { category: errorCategory }),
      ...(recoveryStrategy && {
        isRecoverable: recoveryStrategy.isRecoverable,
        recoveryAction: recoveryStrategy.recoveryAction,
      }),
    },
    stages: [],
  }
}

/**
 * Index event attributes into a map
 * 
 * @param attrs - Array of event attributes
 * @returns Map of key-value pairs
 */
export function indexAttributes(
  attrs?: Array<{ key: string; value: string; index?: boolean }>,
): Record<string, string> {
  const map: Record<string, string> = {}
  for (const attr of attrs || []) {
    if (!attr?.key) continue
    map[attr.key] = attr.value
  }
  return map
}

/**
 * Strip quotes from string
 * 
 * @param s - String to strip quotes from
 * @returns String without quotes
 */
export function stripQuotes(s?: string): string | undefined {
  if (typeof s !== 'string') return s
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  return s
}

