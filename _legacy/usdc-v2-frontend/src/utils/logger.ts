/**
 * Logger utility for conditional debug logging.
 * Only logs debug/info messages when VITE_DEBUG is enabled.
 * Error and warn messages are always logged.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const DEBUG_ENABLED = import.meta.env.VITE_DEBUG === 'true' || import.meta.env.VITE_DEBUG === '1'
const LOG_LEVEL = (import.meta.env.VITE_LOG_LEVEL as LogLevel) || 'info'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info

function shouldLog(level: LogLevel): boolean {
  // Always log errors and warnings
  if (level === 'error' || level === 'warn') {
    return true
  }

  // For debug/info, check if debug is enabled or log level allows it
  if (DEBUG_ENABLED) {
    return true
  }

  // Check log level
  return LOG_LEVELS[level] >= currentLogLevel
}

/**
 * Logger utility that conditionally logs based on VITE_DEBUG or VITE_LOG_LEVEL.
 * 
 * Usage:
 *   logger.debug('Debug message', { data })
 *   logger.info('Info message', { data })
 *   logger.warn('Warning message', { data })
 *   logger.error('Error message', { data })
 */
export const logger = {
  /**
   * Debug logs - only shown when VITE_DEBUG=true or VITE_LOG_LEVEL=debug
   */
  debug: (message: string, ...args: unknown[]): void => {
    if (shouldLog('debug')) {
      console.debug(message, ...args)
    }
  },

  /**
   * Info logs - shown when VITE_DEBUG=true or VITE_LOG_LEVEL is info/debug
   */
  info: (message: string, ...args: unknown[]): void => {
    if (shouldLog('info')) {
      console.info(message, ...args)
    }
  },

  /**
   * Warning logs - always shown
   */
  warn: (message: string, ...args: unknown[]): void => {
    if (shouldLog('warn')) {
      console.warn(message, ...args)
    }
  },

  /**
   * Error logs - always shown
   */
  error: (message: string, ...args: unknown[]): void => {
    if (shouldLog('error')) {
      console.error(message, ...args)
    }
  },
}

/**
 * Check if debug logging is enabled
 */
export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED
}

