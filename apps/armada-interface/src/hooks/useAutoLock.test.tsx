// ABOUTME: Tests for useAutoLock — fires lock after the configured idle period; resets on activity; pauses when in-flight tx exists.
// ABOUTME: Uses vi.useFakeTimers + manual atom seeding; renders a minimal harness component that calls the hook.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { useAutoLock } from './useAutoLock'
import { activeRailgunWalletIdAtom, shieldedWalletsAtom } from '@/state/wallet'
import { preferencesAtom, DEFAULT_PREFERENCES } from '@/state/preferences'
import { txListAtom } from '@/state/tx'
import type { TxRecord } from '@/lib/tx/types'

function Harness() {
  useAutoLock()
  return null
}

function setupStore(opts: {
  unlocked?: boolean
  autoLockMinutes?: 5 | 15 | 30
  withInflightTx?: boolean
}) {
  const store = createStore()
  store.set(shieldedWalletsAtom, {
    'rg-1': {
      id: 'rg-1',
      status: opts.unlocked ? 'unlocked' : 'locked',
      railgunAddress: '0zk-test',
    },
  })
  store.set(activeRailgunWalletIdAtom, 'rg-1')
  store.set(preferencesAtom, {
    ...DEFAULT_PREFERENCES,
    autoLockMinutes: opts.autoLockMinutes ?? DEFAULT_PREFERENCES.autoLockMinutes,
  })
  if (opts.withInflightTx) {
    const r: TxRecord<'shield'> = {
      id: 'tx-1',
      kind: 'shield',
      executionState: 'active',
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      updatedSeq: 0,
      createdAt: 0,
      updatedAt: 0,
      meta: { amount: 1_000_000n, feeCacheId: '', fromChainId: 31337 },
      artifacts: {},
      walletContext: { evmAddress: '0x', railgunWalletId: 'rg-1', sourceChainId: 31337 },
    }
    store.set(txListAtom, [r])
  }
  return store
}

describe('useAutoLock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('locks the wallet after the idle timeout when unlocked + idle', () => {
    const store = setupStore({ unlocked: true, autoLockMinutes: 5 })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    // Verify the wallet is unlocked before
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('unlocked')
    act(() => {
      vi.advanceTimersByTime(5 * 60_000 + 1)
    })
    // After the timeout, lock() should have flipped the entry to 'locked'.
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('locked')
  })

  it('does not lock when the wallet is already locked', () => {
    const store = setupStore({ unlocked: false, autoLockMinutes: 5 })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    act(() => {
      vi.advanceTimersByTime(10 * 60_000)
    })
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('locked')
  })

  it('defers locking when a non-terminal tx is in flight', () => {
    const store = setupStore({ unlocked: true, autoLockMinutes: 5, withInflightTx: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    act(() => {
      vi.advanceTimersByTime(5 * 60_000 + 1)
    })
    // Tx is in flight; the hook reschedules instead of locking.
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('unlocked')
  })

  it('resets the timer on user activity', () => {
    const store = setupStore({ unlocked: true, autoLockMinutes: 5 })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    // Advance 4 minutes, then poke activity — total should not yet lock.
    act(() => {
      vi.advanceTimersByTime(4 * 60_000)
    })
    // The throttle is 1s; advance past it so the next event resets.
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    act(() => {
      window.dispatchEvent(new Event('keydown'))
    })
    // Another 4 minutes — still well under 5 from the reset.
    act(() => {
      vi.advanceTimersByTime(4 * 60_000)
    })
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('unlocked')
    // One more minute past the reset's full 5 — should lock now.
    act(() => {
      vi.advanceTimersByTime(2 * 60_000)
    })
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('locked')
  })

  it('locks 5 minutes after the tab becomes hidden, before the idle timeout would fire', () => {
    // Phase 5 hidden-grace: when the document hides, we lock faster than the idle timer
    // (15-min default → 5-min hidden grace). The user briefly switching tabs is not punished
    // (covered by the visible-cancels-grace test below), but a tab they walked away from gets
    // locked sooner than a foreground idle tab.
    const store = setupStore({ unlocked: true, autoLockMinutes: 15 })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    // Hide the document → starts a 5-min hidden-grace timer.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // 4 minutes hidden — not yet locked.
    act(() => {
      vi.advanceTimersByTime(4 * 60_000)
    })
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('unlocked')
    // 1 more minute (total 5) — grace expires, lock fires.
    act(() => {
      vi.advanceTimersByTime(1 * 60_000 + 1)
    })
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('locked')
  })

  it('cancels the hidden grace when the tab becomes visible again', () => {
    const store = setupStore({ unlocked: true, autoLockMinutes: 15 })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // 4 minutes hidden, then visible again — grace cancelled.
    act(() => {
      vi.advanceTimersByTime(4 * 60_000)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // Advance another 2 minutes (would have crossed the hidden grace if not cancelled).
    act(() => {
      vi.advanceTimersByTime(2 * 60_000)
    })
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('unlocked')
  })

  it('locks synchronously on beforeunload (best-effort zeroize before the page is torn down)', () => {
    const store = setupStore({ unlocked: true, autoLockMinutes: 15 })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    expect(store.get(shieldedWalletsAtom)['rg-1']?.status).toBe('locked')
  })
})
