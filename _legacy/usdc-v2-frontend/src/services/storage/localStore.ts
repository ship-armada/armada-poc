const STORAGE_PREFIX = 'usdc-v2-frontend'
const BIGINT_PREFIX = '__BIGINT__'

function withPrefix(key: string): string {
  return `${STORAGE_PREFIX}:${key}`
}

/**
 * JSON replacer function to convert BigInt values to strings
 * BigInt values are serialized as "__BIGINT__<value>" strings
 */
function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return `${BIGINT_PREFIX}${value.toString()}`
  }
  return value
}

/**
 * JSON reviver function to convert BigInt strings back to BigInt values
 * Strings matching "__BIGINT__<value>" are converted back to BigInt
 */
function bigIntReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(BIGINT_PREFIX)) {
    return BigInt(value.slice(BIGINT_PREFIX.length))
  }
  return value
}

export function saveItem<T>(key: string, value: T): void {
  try {
    localStorage.setItem(withPrefix(key), JSON.stringify(value, bigIntReplacer))
  } catch (error) {
    console.warn('Failed to persist item', key, error)
  }
}

export function loadItem<T>(key: string): T | undefined {
  const value = localStorage.getItem(withPrefix(key))
  if (!value) return undefined
  try {
    return JSON.parse(value, bigIntReviver) as T
  } catch (error) {
    console.warn('Failed to read item', key, error)
    return undefined
  }
}

export function deleteItem(key: string): void {
  localStorage.removeItem(withPrefix(key))
}

// TODO: Encrypt sensitive data before storing in localStorage.
