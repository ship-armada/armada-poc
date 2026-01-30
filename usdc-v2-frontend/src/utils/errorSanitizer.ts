/**
 * Error Sanitization Utility
 * 
 * Maps technical error messages to human-readable strings for better UX.
 * Preserves original error details for debugging via collapsible sections.
 */

export interface SanitizedError {
  /** Human-readable error message for display */
  message: string
  /** Full original error details (for debugging) */
  rawError: string
  /** Error category for styling/icon purposes */
  category?: 'user_rejection' | 'network' | 'rpc' | 'balance' | 'timeout' | 'validation' | 'unknown'
}

/**
 * Extract error message from various error formats
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object') {
    // Try to extract from common error object structures
    const obj = error as Record<string, unknown>
    if (obj.message && typeof obj.message === 'string') {
      return obj.message
    }
    if (obj.error) {
      return extractErrorMessage(obj.error)
    }
    if (obj.reason && typeof obj.reason === 'string') {
      return obj.reason
    }
    // Fallback to JSON stringification
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/**
 * Extract full error details as string for debugging
 */
function extractRawError(error: unknown): string {
  if (error instanceof Error) {
    // Include stack trace if available
    return error.stack || error.message
  }
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error, null, 2)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/**
 * Check if error is a user rejection (MetaMask, wallet, etc.)
 */
function isUserRejection(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return (
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('action_rejected') ||
    lower.includes('action="sendtransaction"') ||
    lower.includes('rejected') ||
    lower.includes('user cancelled') ||
    lower.includes('user canceled') ||
    lower.includes('ethers-user-denied') ||
    lower.includes('metamask tx signature: user denied')
  )
}

/**
 * Check if error is a network/connection error
 */
function isNetworkError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return (
    lower.includes('network') ||
    lower.includes('connection') ||
    lower.includes('fetch failed') ||
    lower.includes('networkerror') ||
    lower.includes('failed to fetch') ||
    lower.includes('network request failed')
  )
}

/**
 * Check if error is an RPC error
 */
function isRpcError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return (
    lower.includes('rpc') ||
    lower.includes('json-rpc') ||
    lower.includes('method not found') ||
    lower.includes('invalid params') ||
    lower.includes('execution reverted') ||
    lower.includes('revert') ||
    lower.includes('invalid response')
  )
}

/**
 * Check if error is a balance/insufficient funds error
 */
function isBalanceError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return (
    lower.includes('insufficient') ||
    lower.includes('balance') ||
    lower.includes('not enough') ||
    lower.includes('exceeds balance')
  )
}

/**
 * Check if error is a timeout error
 */
function isTimeoutError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('deadline exceeded') ||
    lower.includes('request timeout')
  )
}

/**
 * Check if error is a validation error
 */
function isValidationError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return (
    lower.includes('invalid') ||
    lower.includes('validation') ||
    lower.includes('malformed') ||
    lower.includes('bad request')
  )
}

/**
 * Sanitize error message to human-readable format
 */
export function sanitizeError(error: unknown): SanitizedError {
  const errorMessage = extractErrorMessage(error)
  const rawError = extractRawError(error)

  // User rejection errors (highest priority)
  if (isUserRejection(errorMessage)) {
    return {
      message: 'Transaction was cancelled',
      rawError,
      category: 'user_rejection',
    }
  }

  // Network errors
  if (isNetworkError(errorMessage)) {
    return {
      message: 'Network connection issue. Please check your internet connection and try again',
      rawError,
      category: 'network',
    }
  }

  // RPC errors
  if (isRpcError(errorMessage)) {
    return {
      message: 'Unable to connect to blockchain. Please try again',
      rawError,
      category: 'rpc',
    }
  }

  // Balance errors
  if (isBalanceError(errorMessage)) {
    // Try to preserve the specific balance message if it's already user-friendly
    if (errorMessage.toLowerCase().includes('insufficient usdc balance')) {
      return {
        message: errorMessage, // Already user-friendly
        rawError,
        category: 'balance',
      }
    }
    return {
      message: 'Insufficient balance',
      rawError,
      category: 'balance',
    }
  }

  // Timeout errors
  if (isTimeoutError(errorMessage)) {
    return {
      message: 'Request timed out. Please try again',
      rawError,
      category: 'timeout',
    }
  }

  // Validation errors
  if (isValidationError(errorMessage)) {
    // Validation errors are often already user-friendly, so preserve them
    return {
      message: errorMessage,
      rawError,
      category: 'validation',
    }
  }

  // Check for specific common error patterns
  const lower = errorMessage.toLowerCase()

  // MetaMask specific errors
  if (lower.includes('metamask') && lower.includes('not available')) {
    return {
      message: 'MetaMask not available. Please install and connect MetaMask',
      rawError,
      category: 'unknown',
    }
  }

  // Namada specific errors
  if (lower.includes('namada') && (lower.includes('not available') || lower.includes('not connected'))) {
    return {
      message: 'Namada Keychain not available. Please install and connect the Namada extension',
      rawError,
      category: 'unknown',
    }
  }

  // Chain configuration errors
  if (lower.includes('chain configuration') || lower.includes('chain not found')) {
    return {
      message: 'Chain configuration error. Please try again',
      rawError,
      category: 'unknown',
    }
  }

  // Gas estimation errors
  if (lower.includes('gas') && (lower.includes('estimation') || lower.includes('limit'))) {
    return {
      message: 'Transaction gas estimation failed. Please try again',
      rawError,
      category: 'unknown',
    }
  }

  // Default: return original message if it's reasonably short and readable
  // Otherwise, provide a generic message
  if (errorMessage.length > 200 || errorMessage.includes('{') || errorMessage.includes('code=')) {
    return {
      message: 'An error occurred. Please try again',
      rawError,
      category: 'unknown',
    }
  }

  // Message is already reasonably readable
  return {
    message: errorMessage,
    rawError,
    category: 'unknown',
  }
}

/**
 * Get a short error message for toasts (truncated if needed)
 */
export function getShortErrorMessage(error: unknown, maxLength: number = 100): string {
  const sanitized = sanitizeError(error)
  if (sanitized.message.length <= maxLength) {
    return sanitized.message
  }
  return sanitized.message.slice(0, maxLength - 3) + '...'
}

