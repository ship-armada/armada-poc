// ABOUTME: Tests for useIncomingTransferDetector — subscribes on unlock, bumps historyRecoveryEpochAtom on each matching balance event, ignores events for other wallets, cleans up on lock/unmount.
// ABOUTME: Stubs subscribeBalanceUpdates so we can drive synthetic events without a SDK runtime.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import {
  activeShieldedWalletIdAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'
import { historyRecoveryEpochAtom } from '@/state/history'

const hoisted = vi.hoisted(() => {
  let captured: ((event: { chain: { type: 0; id: number }; shieldedWalletID: string }) => void) | null = null
  const subscribe = vi.fn(async (listener: typeof captured) => {
    captured = listener
    return () => {
      captured = null
    }
  })
  return {
    subscribe,
    fire(event: { chain: { type: 0; id: number }; shieldedWalletID: string }) {
      if (captured) captured(event)
    },
    isSubscribed: () => captured !== null,
  }
})

vi.mock('@/lib/shielded/sync', () => ({
  subscribeBalanceUpdates: hoisted.subscribe,
}))

import { useIncomingTransferDetector } from './useIncomingTransferDetector'

function Harness() {
  useIncomingTransferDetector()
  return null
}

function makeStore(opts: { unlocked: boolean }) {
  const store = createStore()
  store.set(shieldedWalletsAtom, {
    'rg-1': {
      id: 'rg-1',
      status: opts.unlocked ? 'unlocked' : 'locked',
      shieldedAddress: '0zk-test',
    },
  })
  store.set(activeShieldedWalletIdAtom, opts.unlocked ? 'rg-1' : null)
  return store
}

beforeEach(() => {
  hoisted.subscribe.mockClear()
})

describe('useIncomingTransferDetector', () => {
  it('does not subscribe while the wallet is locked', async () => {
    const store = makeStore({ unlocked: false })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await Promise.resolve()
    expect(hoisted.subscribe).not.toHaveBeenCalled()
  })

  it('coalesces a burst of matching balance events into a single debounced epoch bump', async () => {
    // WHY (P1-29): the SDK fires several balance events during one scan (one per affected tree /
    // token). Bumping the epoch per-event triggered N back-to-back delta scans. A 2s trailing
    // debounce collapses the burst into one bump → one scan. The bump still happens (received
    // transfers surface live), just once per quiet window instead of once per raw event.
    vi.useFakeTimers()
    try {
      const store = makeStore({ unlocked: true })
      render(
        <Provider store={store}>
          <Harness />
        </Provider>,
      )
      // Flush the async subscribe IIFE (microtasks aren't faked, only timers).
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(hoisted.isSubscribed()).toBe(true)
      expect(store.get(historyRecoveryEpochAtom)).toBe(0)

      // Three rapid events within the window — no bump yet.
      act(() => {
        hoisted.fire({ chain: { type: 0, id: 31337 }, shieldedWalletID: 'rg-1' })
        hoisted.fire({ chain: { type: 0, id: 31337 }, shieldedWalletID: 'rg-1' })
        hoisted.fire({ chain: { type: 0, id: 31337 }, shieldedWalletID: 'rg-1' })
      })
      expect(store.get(historyRecoveryEpochAtom)).toBe(0)

      // After the 2s quiet window, exactly one bump.
      act(() => {
        vi.advanceTimersByTime(2_000)
      })
      expect(store.get(historyRecoveryEpochAtom)).toBe(1)

      // A later, separate event bumps again after its own window.
      act(() => {
        hoisted.fire({ chain: { type: 0, id: 31337 }, shieldedWalletID: 'rg-1' })
      })
      act(() => {
        vi.advanceTimersByTime(2_000)
      })
      expect(store.get(historyRecoveryEpochAtom)).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores balance events for a different wallet', async () => {
    // WHY: defense-in-depth for the future plural-wallet schema. A balance event from a
    // background wallet should not trigger a scan for the active one.
    const store = makeStore({ unlocked: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.isSubscribed()).toBe(true)
    })
    await act(async () => {
      hoisted.fire({ chain: { type: 0, id: 31337 }, shieldedWalletID: 'rg-other' })
    })
    expect(store.get(historyRecoveryEpochAtom)).toBe(0)
  })

  it('unsubscribes when the wallet locks', async () => {
    // WHY: a leaked listener would survive lock and write to atoms across sessions — a privacy
    // bug since the per-wallet historyEncryptionKey is gone by then anyway, but also a memory
    // leak as listeners accumulate.
    const store = makeStore({ unlocked: true })
    const { rerender } = render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.isSubscribed()).toBe(true)
    })
    await act(async () => {
      store.set(shieldedWalletsAtom, {
        'rg-1': { id: 'rg-1', status: 'locked' },
      })
      store.set(activeShieldedWalletIdAtom, null)
    })
    rerender(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.isSubscribed()).toBe(false)
    })
  })
})
