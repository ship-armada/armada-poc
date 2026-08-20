// ABOUTME: Pure mapping from the active shielded-wallet status to the App's guard mode.
// ABOUTME: Extracted from App.tsx so the lock / reset / account-switch transitions are unit-testable without the full provider tree.

export type GuardMode = 'pre-migration' | 'pre-init' | 'signin' | 'app'
export type ShieldedStatus = 'locked' | 'unlocked' | 'missing'

/**
 * While in 'app' mode, decide whether a wallet-status change should bump us to another guard mode.
 * Returns the next mode, or null when no transition is needed.
 *   locked  → 'signin' (auto-lock timer / account-switch locked the wallet)
 *   missing → 'signin' (Settings → Reset wiped the wallet, or an account-switch landed on an
 *                       account with no wallet on this device — otherwise the app shell renders
 *                       with no active wallet and the first action throws). (P1-14)
 * The unified sign-in screen serves both cases: sign-in re-derives (or first-derives) the wallet,
 * and restore-from-backup is available behind a link.
 * Outside 'app' mode the cold-boot derivation effect owns the mode, so this is a no-op.
 */
export function appModeForWalletStatus(mode: GuardMode, status: ShieldedStatus): GuardMode | null {
  if (mode !== 'app') return null
  if (status === 'locked' || status === 'missing') return 'signin'
  return null
}
