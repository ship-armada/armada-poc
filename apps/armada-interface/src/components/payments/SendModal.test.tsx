// ABOUTME: Tests for SendModal orchestrator — open/closed gating, tab switching clears recipient, kind selection visible in review, progress advance.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { SendModal } from './SendModal'
import { openModalAtom } from '@/state/ui'
import { shieldedUsdcAtom } from '@/state/wallet'
import { feeQuoteAtom } from '@/state/fees'
import { withTestQueryClient } from '@/test-utils/queryClient'

const VALID_EVM = '0x1234567890abcdef1234567890abcdef12345678'
const VALID_0ZK = '0zk' + 'a'.repeat(40)

const FAKE_QUOTE = {
  cacheId: 'test-cache',
  expiresAt: Date.now() + 5 * 60_000,
  chainId: 31337,
  // Shape-valid 0zk for the submit-time isShieldedAddress() check on the external-tab→hub path.
  broadcasterRailgunAddress: '0zk' + 'a'.repeat(64),
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
}

function renderModal(opts?: { open?: boolean; shielded?: bigint }) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, 'payment')
  if (opts?.shielded !== undefined) store.set(shieldedUsdcAtom, opts.shielded)
  store.set(feeQuoteAtom, FAKE_QUOTE)
  render(withTestQueryClient(
    <Provider store={store}>
      <SendModal />
    </Provider>,
  ))
  return store
}

describe('<SendModal>', () => {
  it('renders nothing when openModal !== payment', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the input step with title "Send" when open', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    expect(screen.getByRole('dialog', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Private/ })).toBeInTheDocument()
  })

  it('private tab: enters 0zk recipient, advances to review with "Private transfer" label', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_0ZK } })
    fireEvent.change(screen.getByLabelText('How much USDC?'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(screen.getByText('Private transfer')).toBeInTheDocument()
  })

  it('external + xchain: shows the cross-chain tag in review', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.click(screen.getByRole('tab', { name: /External wallet/ }))
    fireEvent.change(screen.getByLabelText('To chain'), { target: { value: '31338' } })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_EVM } })
    fireEvent.change(screen.getByLabelText('How much USDC?'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(screen.getByText('cross-chain')).toBeInTheDocument()
  })

  it('switching tabs clears the recipient field', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_0ZK } })
    fireEvent.click(screen.getByRole('tab', { name: /External wallet/ }))
    expect(screen.getByLabelText('Recipient address')).toHaveValue('')
  })

  it('Confirm advances to the progress step', async () => {
    renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: VALID_0ZK } })
    fireEvent.change(screen.getByLabelText('How much USDC?'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm send/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })
  })

  it('Cancel closes the modal', () => {
    const store = renderModal({ open: true, shielded: 10_000_000n })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })
})
