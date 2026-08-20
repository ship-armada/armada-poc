// ABOUTME: Tests for the Request-via-link flow — compose → generated link screen, with disabled revoke + copy-address hand-off.
// ABOUTME: Seeds an unlocked shielded wallet so the link builder has a real 0zk recipient.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { RequestModal } from './RequestModal'
import { openModalAtom } from '@/state/ui'
import { activeShieldedWalletIdAtom, shieldedWalletsAtom } from '@/state/wallet'

const VALID_0ZK = '0zk' + 'a'.repeat(40)

function renderRequest() {
  const store = createStore()
  store.set(shieldedWalletsAtom, {
    w1: { id: 'w1', status: 'unlocked', shieldedAddress: VALID_0ZK },
  })
  store.set(activeShieldedWalletIdAtom, 'w1')
  store.set(openModalAtom, 'request')
  render(
    <Provider store={store}>
      <RequestModal />
    </Provider>,
  )
  return store
}

describe('<RequestModal>', () => {
  it('renders nothing when the request modal is not open', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <RequestModal />
      </Provider>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens on the compose step with the create-link CTA gated on an amount', () => {
    renderRequest()
    expect(screen.getByRole('heading', { name: 'Request USDC via link' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Input amount' })).toBeDisabled()
  })

  it('generates a real pay-via-link on Create and shows the link screen', () => {
    renderRequest()
    fireEvent.change(screen.getByLabelText('Requested amount in USDC'), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    expect(screen.getByRole('heading', { name: 'USDC payment request' })).toBeInTheDocument()
    expect(screen.getByText('Share this link')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    // The generated link is a real /pay-via-link URL carrying the recipient + amount.
    const linkEl = screen.getByTitle(/\/pay-via-link\?/)
    expect(linkEl.getAttribute('title')).toContain(`to=${VALID_0ZK}`)
    expect(linkEl.getAttribute('title')).toContain('amount=25')
  })

  it('disables Revoke with a "coming soon" marker (real revoke needs backend state)', () => {
    renderRequest()
    fireEvent.change(screen.getByLabelText('Requested amount in USDC'), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    expect(screen.getByRole('button', { name: 'Revoke link' })).toBeDisabled()
    expect(screen.getByText('Coming soon')).toBeInTheDocument()
  })

  it('hands off the amount-less path to the copy-address dialog', () => {
    const store = renderRequest()
    fireEvent.click(screen.getByRole('button', { name: 'Copy your address instead' }))
    expect(store.get(openModalAtom)).toBe('receive')
  })
})
