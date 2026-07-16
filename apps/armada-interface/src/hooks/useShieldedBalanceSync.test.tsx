// ABOUTME: Tests for useShieldedBalanceSync — resets sync state to idle on lock/account switch (W-1).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { Provider, createStore } from 'jotai'

// Mock the SDK + deployment boundaries so importing the hook doesn't pull the Railgun engine into
// jsdom. The locked branch under test runs synchronously and never reaches these.
vi.mock('@/lib/railgun/sync', () => ({
  subscribeBalanceUpdates: vi.fn(async () => () => {}),
  refreshShieldedBalances: vi.fn(async () => {}),
  getShieldedERC20Balance: vi.fn(async () => 0n),
}))
vi.mock('@/config/deployments', () => ({
  loadDeployments: vi.fn(async () => ({ hub: { cctp: { usdc: '0xusdc' } } })),
  loadYieldDeployment: vi.fn(async () => null),
}))

import { useShieldedBalanceSync } from './useShieldedBalanceSync'
import {
  shieldedWalletsAtom,
  activeRailgunWalletIdAtom,
  shieldedUsdcAtom,
  syncStateAtom,
} from '@/state/wallet'

function Harness() {
  useShieldedBalanceSync()
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useShieldedBalanceSync — W-1 sync reset', () => {
  it('resets sync state to idle when no wallet is unlocked (lock / account switch)', () => {
    // WHY (W-1): after wallet A's scan completes, syncStateAtom is 'complete'. On lock/switch we
    // must reset it — otherwise wallet B inherits 'complete', so its dashboard renders ungated
    // with a null balance and enabled spend buttons until B's first scan event. The locked branch
    // must also drop the stale balance.
    const store = createStore()
    // Simulate wallet A having finished its scan, then locking (no active unlocked wallet).
    store.set(syncStateAtom, { status: 'complete', progress: 1 })
    store.set(shieldedUsdcAtom, 5_000_000n)
    store.set(shieldedWalletsAtom, {})
    store.set(activeRailgunWalletIdAtom, null)

    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )

    expect(store.get(syncStateAtom)).toEqual({ status: 'idle', progress: 0 })
    expect(store.get(shieldedUsdcAtom)).toBeNull()
  })
})
