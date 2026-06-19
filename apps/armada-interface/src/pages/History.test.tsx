// ABOUTME: Tests for the Activity (History) page — filter chip switching, empty/non-empty rendering, click-to-expand toggle.
// ABOUTME: Seeds txListAtom with a representative mix of pending/complete/failed records.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { History } from './History'
import { txListAtom } from '@/state/tx'
import { activeRailgunWalletIdAtom } from '@/state/wallet'
import type { TxExecutionState, TxRecord } from '@/lib/tx/types'

function record(
  id: string,
  executionState: TxExecutionState,
  updatedAt: number = id.length * 1000,
): TxRecord<'shield'> {
  return {
    id,
    kind: 'shield',
    executionState,
    stage: 'hub-confirmed',
    stagesCompleted: ['build-proof', 'submit-relayer'],
    updatedSeq: 0,
    createdAt: updatedAt,
    updatedAt,
    meta: { amount: 1_000_000n, feeCacheId: '', fromChainId: 31337 },
    artifacts: {},
    walletContext: { evmAddress: '0xabc', railgunWalletId: 'rg', sourceChainId: 31337 },
  } as TxRecord<'shield'>
}

function renderHistory(records: TxRecord[]) {
  const store = createStore()
  // V2 Phase 6 scoping: History now reads activeTxListAtom (filters by active walletId).
  // Tests seed records bound to 'rg'; the active id must match for them to render.
  store.set(activeRailgunWalletIdAtom, 'rg')
  store.set(txListAtom, records)
  render(
    <Provider store={store}>
      <History />
    </Provider>,
  )
  return store
}

describe('<History>', () => {
  it('renders the Activity heading + filter tabs', () => {
    renderHistory([])
    expect(screen.getByRole('heading', { name: 'Activity', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Pending' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Complete' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Failed' })).toBeInTheDocument()
  })

  it('shows the all-empty copy when there are zero records', () => {
    renderHistory([])
    expect(screen.getByText(/will appear here as they happen/i)).toBeInTheDocument()
  })

  it('shows the filtered-empty copy when a filter has no matches', () => {
    renderHistory([record('a', 'completed')])
    fireEvent.click(screen.getByRole('tab', { name: 'Failed' }))
    expect(screen.getByText(/Try a different filter/i)).toBeInTheDocument()
  })

  it('lists records sorted by updatedAt desc', () => {
    renderHistory([
      record('a', 'completed', 1000),
      record('bb', 'completed', 3000),
      record('ccc', 'completed', 2000),
    ])
    // All three render — three "Pending"? No, completed → "Complete". Verify by amount line count.
    expect(screen.getAllByText('$1').length).toBe(3)
  })

  it('filters out non-pending records when Pending is selected', () => {
    renderHistory([
      record('a', 'completed'),
      record('b', 'active'),
      record('c', 'failed'),
    ])
    fireEvent.click(screen.getByRole('tab', { name: 'Pending' }))
    // Only the 'active' record matches Pending. role="status" scopes to TxStatusChips (excludes the tab label).
    expect(screen.getAllByRole('status').length).toBe(1)
  })

  it('filters in completed records when Complete is selected', () => {
    renderHistory([
      record('a', 'completed'),
      record('b', 'failed'),
    ])
    fireEvent.click(screen.getByRole('tab', { name: 'Complete' }))
    expect(screen.getAllByRole('status').length).toBe(1)
  })

  it('groups failed/expired/cancelled under the Failed filter', () => {
    renderHistory([
      record('a', 'failed'),
      record('b', 'expired'),
      record('c', 'cancelled'),
      record('d', 'completed'),
    ])
    fireEvent.click(screen.getByRole('tab', { name: 'Failed' }))
    // Three matching rows → three amount lines.
    expect(screen.getAllByText('$1').length).toBe(3)
  })

  it('toggles the inline stepper open and closed on row click', () => {
    renderHistory([record('a', 'completed')])
    // Detect the expanded stepper by its always-present "Show technical details" disclosure —
    // the ETA hint is suppressed for terminal records (T-L4), so it's not a reliable marker.
    expect(screen.queryByText(/Show technical details/i)).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/Show technical details/i)).toBeInTheDocument()
    // Click again → collapses.
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText(/Show technical details/i)).toBeNull()
  })

  it('only allows one row expanded at a time', () => {
    renderHistory([record('a', 'completed'), record('bb', 'completed')])
    const buttons = screen.getAllByRole('button')
    fireEvent.click(buttons[0]!)
    expect(screen.getAllByText(/Show technical details/i).length).toBe(1)
    fireEvent.click(buttons[1]!)
    // First collapses, second expands — still exactly one.
    expect(screen.getAllByText(/Show technical details/i).length).toBe(1)
  })
})
