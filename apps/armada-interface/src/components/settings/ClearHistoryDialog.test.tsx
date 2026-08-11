// ABOUTME: Tests for ClearHistoryDialog — confirm-gated cacheClear + checkpoint drop + atom reset + epoch bump.
// ABOUTME: Stubs lib/cache and lib/railgun/history-checkpoint so the actions are observable without touching IDB.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { txListAtom } from '@/state/tx'
import { activeShieldedWalletIdAtom } from '@/state/wallet'
import { historyRecoveryEpochAtom } from '@/state/history'

const hoisted = vi.hoisted(() => ({
  cacheClear: vi.fn(async () => {}),
  clearHistoryCheckpoint: vi.fn(() => {}),
}))

vi.mock('@/lib/cache', () => ({
  cacheClear: hoisted.cacheClear,
}))

vi.mock('@/lib/railgun/history-checkpoint', () => ({
  clearHistoryCheckpoint: hoisted.clearHistoryCheckpoint,
}))

import { ClearHistoryDialog } from './ClearHistoryDialog'

const SEEDED_RECORD = {
  id: '01J',
  kind: 'shield' as const,
  executionState: 'completed' as const,
  stage: 'hub-confirmed' as const,
  stagesCompleted: ['build-proof', 'submit-relayer', 'hub-confirmed'] as const,
  updatedSeq: 0,
  createdAt: 0,
  updatedAt: 0,
  meta: { amount: 1n, feeCacheId: '', fromChainId: 31337 },
  artifacts: {},
  walletContext: { evmAddress: undefined, shieldedWalletId: 'rg-1', sourceChainId: 31337 },
}

function setup(opts: { open: boolean }) {
  const store = createStore()
  store.set(activeShieldedWalletIdAtom, 'rg-1')
  store.set(txListAtom, [SEEDED_RECORD as never])
  render(
    <Provider store={store}>
      <ClearHistoryDialog open={opts.open} onClose={() => {}} />
    </Provider>,
  )
  return store
}

beforeEach(() => {
  hoisted.cacheClear.mockClear()
  hoisted.clearHistoryCheckpoint.mockClear()
})

describe('<ClearHistoryDialog>', () => {
  it('renders nothing when closed', () => {
    setup({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('clears local storage + checkpoint + atom and bumps the epoch on Clear', async () => {
    // WHY: this is the multi-step contract. Any partial application (e.g. wiping IDB but not
    // the atom) leaves the UI showing stale rows. We verify every effect fires in one go.
    const store = setup({ open: true })
    expect(store.get(txListAtom).length).toBe(1)
    expect(store.get(historyRecoveryEpochAtom)).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /Clear history/i }))
    await waitFor(() => {
      expect(hoisted.cacheClear).toHaveBeenCalledWith('txHistory')
    })
    expect(hoisted.clearHistoryCheckpoint).toHaveBeenCalledWith('rg-1')
    expect(store.get(txListAtom).length).toBe(0)
    expect(store.get(historyRecoveryEpochAtom)).toBe(1)
  })

  it('shows the error inline + leaves the atom intact when cacheClear throws', async () => {
    // WHY: a transient IDB error (quota, blocked, etc.) shouldn't leave the user with a
    // half-cleared state or a silent failure. Surface the error and don't apply partial side
    // effects.
    hoisted.cacheClear.mockRejectedValueOnce(new Error('quota exceeded'))
    const store = setup({ open: true })
    fireEvent.click(screen.getByRole('button', { name: /Clear history/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/quota exceeded/i)
    })
    expect(store.get(txListAtom).length).toBe(1)
    expect(store.get(historyRecoveryEpochAtom)).toBe(0)
  })
})
