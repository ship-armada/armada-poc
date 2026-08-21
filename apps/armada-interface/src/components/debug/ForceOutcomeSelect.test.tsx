// ABOUTME: Tests for the debug ForceOutcomeSelect — hidden unless debug mode is on; a selection writes devForceOutcomeAtom.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { ForceOutcomeSelect } from './ForceOutcomeSelect'
import { debugModeAtom, devForceOutcomeAtom } from '@/state/debug'

function renderWith(debug: boolean) {
  const store = createStore()
  store.set(debugModeAtom, debug)
  render(
    <Provider store={store}>
      <ForceOutcomeSelect />
    </Provider>,
  )
  return store
}

describe('ForceOutcomeSelect', () => {
  it('renders nothing when debug mode is off', () => {
    renderWith(false)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('renders the control when debug mode is on', () => {
    renderWith(true)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByText(/DEBUG · force outcome/)).toBeInTheDocument()
  })

  it('writes the chosen code to devForceOutcomeAtom, and null for "Normal"', () => {
    const store = renderWith(true)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'TX_REVERTED' } })
    expect(store.get(devForceOutcomeAtom)).toBe('TX_REVERTED')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(store.get(devForceOutcomeAtom)).toBeNull()
  })
})
