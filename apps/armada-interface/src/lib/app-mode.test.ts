// ABOUTME: Tests for appModeForWalletStatus (P1-14) — the app-mode guard transitions on wallet-status change.
// ABOUTME: Both 'locked' and 'missing' route to the unified 'signin' screen (sign-in re-derives / first-derives; restore-from-backup is available behind a link).

import { describe, it, expect } from 'vitest'
import { appModeForWalletStatus } from './app-mode'

describe('appModeForWalletStatus', () => {
  it('routes a locked wallet to the sign-in screen', () => {
    expect(appModeForWalletStatus('app', 'locked')).toBe('signin')
  })

  it('routes a missing wallet to the sign-in screen (Settings → Reset / account-switch-to-unknown)', () => {
    expect(appModeForWalletStatus('app', 'missing')).toBe('signin')
  })

  it('stays put when the wallet is unlocked', () => {
    expect(appModeForWalletStatus('app', 'unlocked')).toBeNull()
  })

  it('is a no-op outside app mode — the cold-boot derivation owns the mode there', () => {
    expect(appModeForWalletStatus('signin', 'missing')).toBeNull()
    expect(appModeForWalletStatus('pre-init', 'unlocked')).toBeNull()
  })
})
