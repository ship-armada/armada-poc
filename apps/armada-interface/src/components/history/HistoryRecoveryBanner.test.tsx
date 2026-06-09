// ABOUTME: Tests for HistoryRecoveryBanner — hidden when idle, "Recovering…" while scanning, error copy + Retry CTA on failure that bumps historyRecoveryEpochAtom.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { HistoryRecoveryBanner } from './HistoryRecoveryBanner'
import { historyRecoveryAtom, historyRecoveryEpochAtom } from '@/state/history'

function renderWith(opts: { state: 'idle' | 'scanning' | 'failed'; error?: string }) {
  const store = createStore()
  store.set(historyRecoveryAtom, opts.error
    ? { state: opts.state, error: opts.error }
    : { state: opts.state })
  render(
    <Provider store={store}>
      <HistoryRecoveryBanner />
    </Provider>,
  )
  return store
}

describe('<HistoryRecoveryBanner>', () => {
  it('renders nothing when state is idle', () => {
    renderWith({ state: 'idle' })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the "Recovering…" copy while scanning', () => {
    renderWith({ state: 'scanning' })
    expect(screen.getByText(/Recovering activity from chain/i)).toBeInTheDocument()
  })

  it('shows error copy + Retry CTA on failure; clicking Retry bumps the epoch atom', () => {
    // WHY: Retry is the user's escape hatch when the SDK / RPC blip and the scan errored.
    // The banner must surface a CTA, not just sit on the error — that would strand them.
    const store = renderWith({ state: 'failed', error: 'rpc unreachable' })
    expect(screen.getByText(/Couldn't recover activity from chain/i)).toBeInTheDocument()
    expect(screen.getByText(/rpc unreachable/i)).toBeInTheDocument()
    expect(store.get(historyRecoveryEpochAtom)).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    expect(store.get(historyRecoveryEpochAtom)).toBe(1)
  })
})
