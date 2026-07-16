// ABOUTME: Tests for appModeForWalletStatus (P1-14) — the app-mode guard transitions on wallet-status change.
// ABOUTME: The 'missing' → 'onboarding' case is the fix: Settings → Reset / account-switch-to-unknown must leave app mode instead of rendering a wallet-less shell.

import { describe, it, expect } from 'vitest'
import { appModeForWalletStatus } from './app-mode'

describe('appModeForWalletStatus', () => {
  it('routes a locked wallet back to the unlock screen', () => {
    expect(appModeForWalletStatus('app', 'locked')).toBe('unlock')
  })

  it('routes a missing wallet to onboarding (Settings → Reset / account-switch-to-unknown)', () => {
    expect(appModeForWalletStatus('app', 'missing')).toBe('onboarding')
  })

  it('stays put when the wallet is unlocked', () => {
    expect(appModeForWalletStatus('app', 'unlocked')).toBeNull()
  })

  it('is a no-op outside app mode — the cold-boot derivation owns the mode there', () => {
    expect(appModeForWalletStatus('unlock', 'missing')).toBeNull()
    expect(appModeForWalletStatus('onboarding', 'locked')).toBeNull()
    expect(appModeForWalletStatus('pre-init', 'unlocked')).toBeNull()
  })
})
