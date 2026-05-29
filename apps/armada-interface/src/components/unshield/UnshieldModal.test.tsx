// ABOUTME: Tests for UnshieldModal orchestrator — open/closed gating, step advancement, kind selection (local vs xchain) based on destination.

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { UnshieldModal } from './UnshieldModal'
import { openModalAtom } from '@/state/ui'
import { shieldedUsdcAtom, evmAddressAtom } from '@/state/wallet'
import { feeQuoteAtom } from '@/state/fees'
import { withTestQueryClient } from '@/test-utils/queryClient'

const VALID_ADDR = '0x1234567890abcdef1234567890abcdef12345678'

const FAKE_QUOTE = {
  cacheId: 'test-cache',
  expiresAt: Date.now() + 5 * 60_000,
  chainId: 31337,
  // Shape-valid 0zk for the new isShieldedAddress() submit-time check. UnshieldModal rejects an
  // empty / malformed broadcaster address before kicking proof generation, which is what catches
  // a misconfigured relayer in practice.
  broadcasterRailgunAddress: '0zk' + 'a'.repeat(64),
  fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0' },
}

function renderModal(opts?: {
  open?: boolean
  shielded?: bigint
  evm?: string
}) {
  const store = createStore()
  if (opts?.open) store.set(openModalAtom, 'unshield')
  if (opts?.shielded !== undefined) store.set(shieldedUsdcAtom, opts.shielded)
  if (opts?.evm) store.set(evmAddressAtom, opts.evm)
  store.set(feeQuoteAtom, FAKE_QUOTE)
  render(withTestQueryClient(
    <Provider store={store}>
      <UnshieldModal />
    </Provider>,
  ))
  return store
}

describe('<UnshieldModal>', () => {
  it('renders nothing when openModal !== unshield', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the input step with title "Withdraw" when open', () => {
    renderModal({ open: true, shielded: 10_000_000n })
    expect(screen.getByRole('dialog', { name: 'Withdraw' })).toBeInTheDocument()
    expect(screen.getByLabelText('Recipient address')).toBeInTheDocument()
  })

  it('pre-fills the recipient from the connected EVM address', () => {
    renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    expect(screen.getByDisplayValue(VALID_ADDR)).toBeInTheDocument()
  })

  it('lets the user clear the prefilled recipient without it getting repopulated', () => {
    renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    const input = screen.getByLabelText('Recipient address') as HTMLInputElement
    expect(input.value).toBe(VALID_ADDR)
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
  })

  it('advances to the review step on Continue with valid inputs', () => {
    renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    fireEvent.change(screen.getByLabelText('How much USDC?'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(screen.getByText('Review your withdrawal')).toBeInTheDocument()
  })

  it('shows the xchain tag in review when destination is a client chain', () => {
    renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    fireEvent.change(screen.getByLabelText('To chain'), { target: { value: '31338' } })
    fireEvent.change(screen.getByLabelText('How much USDC?'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(screen.getByText('cross-chain')).toBeInTheDocument()
  })

  it('Confirm advances to the progress step', async () => {
    renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    fireEvent.change(screen.getByLabelText('How much USDC?'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm withdrawal/ }))
    })
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })
  })

  it('Cancel closes the modal', () => {
    const store = renderModal({ open: true, shielded: 10_000_000n, evm: VALID_ADDR })
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(store.get(openModalAtom)).toBeNull()
  })
})
