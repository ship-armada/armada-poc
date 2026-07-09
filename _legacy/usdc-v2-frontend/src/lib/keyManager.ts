/**
 * Key Manager - Closure-based key storage
 *
 * Keys are stored in module-level variables (closure) and never
 * exposed to React state or localStorage. This provides the best
 * security we can achieve in a browser environment.
 */

// ============ Private State ============

// These are never exported - only accessible via functions
let _mnemonic: string | null = null
let _encryptionKey: string | null = null
let _walletId: string | null = null
let _railgunAddress: string | null = null

// Auto-lock timer
let _lockTimer: ReturnType<typeof setTimeout> | null = null
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// Callback for when wallet is locked
let _onLockCallback: (() => void) | null = null

// ============ Key Management ============

/**
 * Set the derived keys after unlocking
 */
export function setKeys(
  mnemonic: string,
  encryptionKey: string,
  walletId: string,
  railgunAddress: string,
): void {
  _mnemonic = mnemonic
  _encryptionKey = encryptionKey
  _walletId = walletId
  _railgunAddress = railgunAddress

  // Start auto-lock timer
  resetLockTimer()
}

/**
 * Get the mnemonic (throws if not unlocked)
 */
export function getMnemonic(): string {
  if (_mnemonic === null) {
    throw new Error('Wallet not unlocked')
  }
  resetLockTimer()
  return _mnemonic
}

/**
 * Get the encryption key (throws if not unlocked)
 */
export function getEncryptionKey(): string {
  if (_encryptionKey === null) {
    throw new Error('Wallet not unlocked')
  }
  resetLockTimer()
  return _encryptionKey
}

/**
 * Get the wallet ID (throws if not unlocked)
 */
export function getWalletId(): string {
  if (_walletId === null) {
    throw new Error('Wallet not unlocked')
  }
  resetLockTimer()
  return _walletId
}

/**
 * Get the Railgun address (throws if not unlocked)
 */
export function getRailgunAddress(): string {
  if (_railgunAddress === null) {
    throw new Error('Wallet not unlocked')
  }
  resetLockTimer()
  return _railgunAddress
}

/**
 * Check if wallet is unlocked
 */
export function isUnlocked(): boolean {
  return _mnemonic !== null
}

/**
 * Clear all keys (lock the wallet)
 */
export function clearKeys(): void {
  // Best-effort clearing (JS doesn't guarantee memory zeroization)
  _mnemonic = null
  _encryptionKey = null
  _walletId = null
  _railgunAddress = null

  // Clear timer
  if (_lockTimer) {
    clearTimeout(_lockTimer)
    _lockTimer = null
  }

  // Notify callback
  if (_onLockCallback) {
    _onLockCallback()
  }
}

// ============ Auto-Lock ============

/**
 * Reset the auto-lock timer
 * Called on any key access to extend the session
 */
function resetLockTimer(): void {
  if (_lockTimer) {
    clearTimeout(_lockTimer)
  }

  _lockTimer = setTimeout(() => {
    console.log('Auto-locking wallet due to inactivity')
    clearKeys()
  }, LOCK_TIMEOUT_MS)
}

/**
 * Set callback for when wallet is locked
 */
export function setOnLockCallback(callback: () => void): void {
  _onLockCallback = callback
}

/**
 * Remove the lock callback
 */
export function removeOnLockCallback(): void {
  _onLockCallback = null
}

// ============ Page Unload ============

// Clear keys when page is unloaded
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    clearKeys()
  })
}
