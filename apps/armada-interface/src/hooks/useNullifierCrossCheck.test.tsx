// ABOUTME: Tests for useNullifierCrossCheck — runs the on-chain nullifier cross-check after a scan completes and writes nullifierCrossCheckAtom.
// ABOUTME: Locked/mid-scan → no check; unlocked + complete → 'ok' or 'omission-detected' per the check result.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import type { ReactNode } from 'react'

const hoisted = vi.hoisted(() => ({
  check: vi.fn(),
  trackError: vi.fn(),
}))
vi.mock('@/lib/railgun/nullifierCrossCheck', () => ({ checkOwnNullifiersOnChain: hoisted.check }))
vi.mock('@/lib/telemetry', () => ({ trackError: hoisted.trackError }))

import { useNullifierCrossCheck } from './useNullifierCrossCheck'
import {
  activeShieldedWalletIdAtom,
  shieldedWalletsAtom,
  syncStateAtom,
  nullifierCrossCheckAtom,
} from '@/state/wallet'
import type { SyncState } from '@/state/wallet'

function mount(store: ReturnType<typeof createStore>) {
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>
  return renderHook(() => useNullifierCrossCheck(), { wrapper })
}

function seed(store: ReturnType<typeof createStore>, status: 'unlocked' | 'locked', sync: SyncState) {
  store.set(shieldedWalletsAtom, { w1: { id: 'w1', status } })
  store.set(activeShieldedWalletIdAtom, 'w1')
  store.set(syncStateAtom, sync)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useNullifierCrossCheck', () => {
  it('flips the atom to omission-detected when the check finds a spent own note', async () => {
    hoisted.check.mockResolvedValue({ checked: 1, omissionDetected: true })
    const store = createStore()
    seed(store, 'unlocked', { status: 'complete', progress: 1 })

    mount(store)

    await waitFor(() => {
      expect(store.get(nullifierCrossCheckAtom)).toBe('omission-detected')
    })
    expect(hoisted.check).toHaveBeenCalledWith('w1')
  })

  it('flips the atom to ok when the check finds no omission', async () => {
    hoisted.check.mockResolvedValue({ checked: 2, omissionDetected: false })
    const store = createStore()
    seed(store, 'unlocked', { status: 'complete', progress: 1 })

    mount(store)

    await waitFor(() => {
      expect(store.get(nullifierCrossCheckAtom)).toBe('ok')
    })
  })

  it('does not run the check while the scan is still in progress', async () => {
    const store = createStore()
    seed(store, 'unlocked', { status: 'syncing', progress: 0.3 })

    mount(store)
    await Promise.resolve()

    expect(hoisted.check).not.toHaveBeenCalled()
    expect(store.get(nullifierCrossCheckAtom)).toBe('unknown')
  })

  it('resets to unknown and does not check when the wallet is locked', async () => {
    hoisted.check.mockResolvedValue({ checked: 0, omissionDetected: false })
    const store = createStore()
    store.set(nullifierCrossCheckAtom, 'omission-detected') // stale prior result
    seed(store, 'locked', { status: 'complete', progress: 1 })

    mount(store)
    await Promise.resolve()

    expect(hoisted.check).not.toHaveBeenCalled()
    expect(store.get(nullifierCrossCheckAtom)).toBe('unknown')
  })
})
