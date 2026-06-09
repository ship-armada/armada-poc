// ABOUTME: Tests for useIncomingTransferDetector — subscribes on unlock, bumps historyRecoveryEpochAtom on each matching balance event, ignores events for other wallets, cleans up on lock/unmount.
// ABOUTME: Stubs subscribeBalanceUpdates so we can drive synthetic events without a Railgun SDK runtime.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import {
  activeRailgunWalletIdAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'
import { historyRecoveryEpochAtom } from '@/state/history'

const hoisted = vi.hoisted(() => {
  let captured: ((event: { chain: { type: 0; id: number }; railgunWalletID: string }) => void) | null = null
  const subscribe = vi.fn(async (listener: typeof captured) => {
    captured = listener
    return () => {
      captured = null
    }
  })
  return {
    subscribe,
    fire(event: { chain: { type: 0; id: number }; railgunWalletID: string }) {
      if (captured) captured(event)
    },
    isSubscribed: () => captured !== null,
  }
})

vi.mock('@/lib/railgun/sync', () => ({
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
      railgunAddress: '0zk-test',
    },
  })
  store.set(activeRailgunWalletIdAtom, opts.unlocked ? 'rg-1' : null)
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

  it('subscribes on unlock and bumps the epoch on each matching balance event', async () => {
    // WHY: every SDK balance event is the canonical "something changed on chain" signal. Each
    // bump triggers useHistoryRecovery to fetch the delta — that's how a received transfer
    // surfaces in the activity feed live. Two events → two epoch bumps.
    const store = makeStore({ unlocked: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.isSubscribed()).toBe(true)
    })
    expect(store.get(historyRecoveryEpochAtom)).toBe(0)
    await act(async () => {
      hoisted.fire({ chain: { type: 0, id: 31337 }, railgunWalletID: 'rg-1' })
    })
    expect(store.get(historyRecoveryEpochAtom)).toBe(1)
    await act(async () => {
      hoisted.fire({ chain: { type: 0, id: 31337 }, railgunWalletID: 'rg-1' })
    })
    expect(store.get(historyRecoveryEpochAtom)).toBe(2)
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
      hoisted.fire({ chain: { type: 0, id: 31337 }, railgunWalletID: 'rg-other' })
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
      store.set(activeRailgunWalletIdAtom, null)
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
