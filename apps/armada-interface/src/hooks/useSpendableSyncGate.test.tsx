// ABOUTME: Tests for useSpendableSyncGate — blocks spend flows on failed sync, first-sync-in-progress, and (WI-5) nullifier-omission detection.
// ABOUTME: The gate is a pure atom reader; these lock the block conditions the spend modals depend on.

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import type { ReactNode } from 'react'
import { useSpendableSyncGate } from './useSpendableSyncGate'
import {
  nullifierCrossCheckAtom,
  shieldedUsdcAtom,
  syncStateAtom,
  type NullifierCrossCheckStatus,
} from '@/state/wallet'
import type { SyncState } from '@/state/wallet'

function renderGate(setup: {
  sync?: SyncState
  shielded?: bigint | null
  crossCheck?: NullifierCrossCheckStatus
}) {
  const store = createStore()
  if (setup.sync) store.set(syncStateAtom, setup.sync)
  store.set(shieldedUsdcAtom, setup.shielded ?? null)
  store.set(nullifierCrossCheckAtom, setup.crossCheck ?? 'unknown')
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>
  return renderHook(() => useSpendableSyncGate(), { wrapper }).result
}

describe('useSpendableSyncGate', () => {
  it('does not block once a scan has completed with a known balance and the cross-check is ok', () => {
    const { current } = renderGate({
      sync: { status: 'complete', progress: 1 },
      shielded: 5_000_000n,
      crossCheck: 'ok',
    })
    expect(current.blocked).toBe(false)
    expect(current.reason).toBeNull()
  })

  it('blocks when the sync failed', () => {
    const { current } = renderGate({ sync: { status: 'failed', progress: 0.5 } })
    expect(current.blocked).toBe(true)
    expect(current.reason).toMatch(/interrupted/i)
  })

  it('blocks during the first sync when the balance is still unknown', () => {
    const { current } = renderGate({ sync: { status: 'syncing', progress: 0.2 }, shielded: null })
    expect(current.blocked).toBe(true)
    expect(current.reason).toMatch(/initial sync/i)
  })

  it('blocks on nullifier omission even when the scan completed with a balance (WI-5)', () => {
    const { current } = renderGate({
      sync: { status: 'complete', progress: 1 },
      shielded: 5_000_000n,
      crossCheck: 'omission-detected',
    })
    expect(current.blocked).toBe(true)
    expect(current.reason).toMatch(/out of date|re-sync/i)
  })

  it('does not block on the default unknown cross-check state', () => {
    const { current } = renderGate({
      sync: { status: 'complete', progress: 1 },
      shielded: 5_000_000n,
      crossCheck: 'unknown',
    })
    expect(current.blocked).toBe(false)
  })
})
