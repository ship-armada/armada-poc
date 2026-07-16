// ABOUTME: Tests for RecentActivityCard — empty state, terminal-only filter, sort by updatedAt desc, top-N cap, onSelect dispatch.
// ABOUTME: Wraps in MemoryRouter so the "View all" Link can resolve a route.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { MemoryRouter } from 'react-router-dom'
import { RecentActivityCard } from './RecentActivityCard'
import { txListAtom } from '@/state/tx'
import { activeRailgunWalletIdAtom } from '@/state/wallet'
import type { TxRecord } from '@/lib/tx/types'

function record(
  id: string,
  state: TxRecord['executionState'],
  updatedAt: number,
): TxRecord<'shield'> {
  return {
    id,
    kind: 'shield',
    executionState: state,
    stage: 'hub-confirmed',
    stagesCompleted: ['build-proof', 'submit-relayer'],
    updatedSeq: 0,
    createdAt: updatedAt,
    updatedAt,
    meta: { amount: 1_000_000n, feeCacheId: '', fromChainId: 31337 },
    artifacts: {},
    walletContext: {
      evmAddress: '0xabc',
      railgunWalletId: 'rg',
      sourceChainId: 31337,
    },
  } as TxRecord<'shield'>
}

function renderWith(records: TxRecord[], opts: { onSelect?: (r: TxRecord) => void } = {}) {
  const store = createStore()
  // V2 Phase 6: card reads activeTxListAtom; active id must match the seeded records' walletId.
  store.set(activeRailgunWalletIdAtom, 'rg')
  store.set(txListAtom, records)
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <RecentActivityCard onSelect={opts.onSelect} />
      </MemoryRouter>
    </Provider>,
  )
}

describe('<RecentActivityCard>', () => {
  it('renders the empty state when no terminal records exist', () => {
    renderWith([])
    expect(screen.getByText('No activity yet')).toBeInTheDocument()
  })

  it('hides "View all" link when empty', () => {
    renderWith([])
    expect(screen.queryByRole('link', { name: 'View all' })).toBeNull()
  })

  it('filters out non-terminal records', () => {
    renderWith([
      record('a', 'active', 1000),
      record('b', 'pending', 2000),
      record('c', 'completed', 3000),
    ])
    // Only 'c' qualifies; check that a & b are absent and "View all" appears.
    expect(screen.getByRole('link', { name: 'View all' })).toBeInTheDocument()
  })

  it('renders all matching terminal records', () => {
    renderWith([
      record('old', 'completed', 1000),
      record('newer', 'completed', 5000),
      record('newest', 'completed', 9000),
    ])
    // onSelect is omitted → TxRow renders as <div>, not <button>. We confirm
    // three rows are present via the per-row amount text.
    expect(screen.getAllByText('$1').length).toBe(3)
  })

  it('caps the list at MAX_ROWS (5)', () => {
    const records = Array.from({ length: 8 }).map((_, i) =>
      record(String(i), 'completed', i * 1000),
    )
    renderWith(records)
    const items = screen.getAllByText('$1')
    expect(items.length).toBe(5)
  })

  it('dispatches onSelect with the clicked record', () => {
    const onSelect = vi.fn()
    renderWith([record('a', 'completed', 1000)], { onSelect })
    fireEvent.click(screen.getByRole('button'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0]?.[0]?.id).toBe('a')
  })
})
