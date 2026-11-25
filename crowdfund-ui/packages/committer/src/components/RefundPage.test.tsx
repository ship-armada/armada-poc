// ABOUTME: Tests for the /refund page: every read state, the wallet gates, and the claimRefund() tx outcomes.
// ABOUTME: Mocks the wallet, the refund read hook and the tx helpers; no chain is involved.
// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { RefundOnlyClaimState } from '@/lib/refundOnlyClaim'

const m = vi.hoisted(() => ({
  wallet: {
    address: null as string | null,
    signer: null as unknown,
    connected: false,
    isWrongNetwork: false,
    connect: vi.fn(),
    switchNetwork: vi.fn(),
  },
  refund: {
    crowdfundAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as string | null,
    provider: null,
    state: null as RefundOnlyClaimState | null,
    loading: false,
    refetch: vi.fn(),
  },
  sendAndWaitTx: vi.fn(),
  submitWrite: vi.fn(),
  resolveSigner: vi.fn(),
  savePendingTx: vi.fn(),
  removePendingTx: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => m.wallet }))
vi.mock('@/hooks/useRefundOnlyClaim', () => ({ useRefundOnlyClaim: () => m.refund }))
vi.mock('@/lib/sendAndWaitTx', () => ({ sendAndWaitTx: m.sendAndWaitTx }))
vi.mock('@/lib/submitWrite', () => ({ submitWrite: m.submitWrite }))
vi.mock('@/lib/resolveSigner', () => ({
  resolveSigner: m.resolveSigner,
  describeSignerError: () => 'Wallet not ready — reconnect and retry.',
}))
vi.mock('@/lib/pendingTx', () => ({ savePendingTx: m.savePendingTx, removePendingTx: m.removePendingTx }))
vi.mock('@/lib/refundOnlyClaim', async (orig) => ({
  ...(await orig<typeof import('@/lib/refundOnlyClaim')>()),
  refundOnlyContract: () => ({ claimRefund: vi.fn() }),
}))

import { RefundPage } from './RefundPage'

const WALLET = '0x1111111111111111111111111111111111111111'
const USDC = (n: number) => BigInt(n) * 1_000_000n

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/refund']}>
      <RefundPage />
    </MemoryRouter>,
  )
}

function connect(state: RefundOnlyClaimState | null, over: Partial<typeof m.wallet> = {}) {
  Object.assign(m.wallet, { address: WALLET, signer: { s: 1 }, connected: true, isWrongNetwork: false }, over)
  m.refund.state = state
}

describe('RefundPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(m.wallet, { address: null, signer: null, connected: false, isWrongNetwork: false })
    Object.assign(m.refund, {
      crowdfundAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      state: null,
      loading: false,
    })
  })

  // WHY: a network with no first sale (e.g. a Sepolia build without the override) has nothing to claim.
  it('says there is nothing to claim when the feature is off', () => {
    m.refund.crowdfundAddress = null
    renderPage()
    expect(screen.getByText(/no first-sale refunds on this network/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /connect wallet/i })).toBeNull()
  })

  it('asks a disconnected visitor to connect', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    expect(m.wallet.connect).toHaveBeenCalled()
  })

  // WHY: the amount is read from the hub regardless of the wallet's network; only the claim needs
  // the wallet on the right chain, so show the amount and ask for the switch.
  it('shows the amount and a network switch on the wrong network', () => {
    connect({ kind: 'eligible', amount: USDC(33_000) }, { connected: false, isWrongNetwork: true })
    renderPage()
    expect(screen.getByText('$33,000')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /claim refund/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /switch network/i }))
    expect(m.wallet.switchNetwork).toHaveBeenCalled()
  })

  it('shows a loading state while reading', () => {
    connect(null)
    m.refund.loading = true
    renderPage()
    expect(screen.getByRole('status').textContent).toMatch(/checking/i)
  })

  // WHY: a failed read must never read as "$0"; offer a retry.
  it('offers a retry when the read fails', () => {
    connect({ kind: 'error' })
    renderPage()
    expect(screen.queryByText('$0')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(m.refund.refetch).toHaveBeenCalled()
  })

  it('tells a wallet that never committed it has no refund', () => {
    connect({ kind: 'none' })
    renderPage()
    expect(screen.getByText(/didn't commit to the first sale/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /claim refund/i })).toBeNull()
  })

  it('shows an already-claimed refund', () => {
    connect({ kind: 'claimed', amount: USDC(500) })
    renderPage()
    expect(screen.getByText(/already claimed/i).textContent).toContain('$500')
    expect(screen.queryByRole('button', { name: /claim refund/i })).toBeNull()
  })

  it('never offers a claim the contract would reject', () => {
    connect({ kind: 'unavailable' })
    renderPage()
    expect(screen.getByText(/aren't available/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /claim refund/i })).toBeNull()
  })

  // WHY: the core path — claimRefund() on the first-sale contract, recorded for the header tx chip,
  // then re-read so the page shows the claimed state.
  it('claims the refund and shows the result', async () => {
    connect({ kind: 'eligible', amount: USDC(1_000) })
    m.sendAndWaitTx.mockImplementation(async (send: () => Promise<unknown>, onSubmitted: (h: string) => void) => {
      await send()
      onSubmitted('0xabc')
      return { outcome: 'success', hash: '0xabc' }
    })
    renderPage()
    expect(screen.getByText('$1,000')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /claim refund/i }))
    await waitFor(() => expect(screen.getByText(/refund claimed/i)).toBeTruthy())
    expect(m.submitWrite).toHaveBeenCalledWith(expect.anything(), 'claimRefund', [], m.wallet.signer)
    expect(m.savePendingTx).toHaveBeenCalledWith(expect.objectContaining({ txHash: '0xabc', address: WALLET }))
    expect(m.removePendingTx).toHaveBeenCalledWith('0xabc')
    expect(m.refund.refetch).toHaveBeenCalled()
  })

  // WHY: useWalletClient can stay empty after a fresh connect; resolve a signer at click time.
  it('resolves a signer at click time when the wallet hook has none', async () => {
    connect({ kind: 'eligible', amount: USDC(1_000) }, { signer: null })
    const resolved = { r: 1 }
    m.resolveSigner.mockResolvedValue(resolved)
    m.sendAndWaitTx.mockImplementation(async (send: () => Promise<unknown>) => {
      await send()
      return { outcome: 'success', hash: '0xabc' }
    })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /claim refund/i }))
    await waitFor(() => expect(m.submitWrite).toHaveBeenCalledWith(expect.anything(), 'claimRefund', [], resolved))
  })

  it('returns quietly to the claim button when the user rejects', async () => {
    connect({ kind: 'eligible', amount: USDC(1_000) })
    m.sendAndWaitTx.mockResolvedValue({ outcome: 'rejected' })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /claim refund/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /claim refund/i })).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the error and lets the user retry after a failed claim', async () => {
    connect({ kind: 'eligible', amount: USDC(1_000) })
    m.sendAndWaitTx.mockResolvedValue({ outcome: 'reverted', hash: '0xdef', errorMessage: 'Transaction reverted' })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /claim refund/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Transaction reverted'))
    expect(m.removePendingTx).toHaveBeenCalledWith('0xdef')
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
  })

  // WHY: a timed-out tx may still confirm, so it stays recorded for the pending-tx watcher.
  it('keeps a timed-out claim recorded as pending', async () => {
    connect({ kind: 'eligible', amount: USDC(1_000) })
    m.sendAndWaitTx.mockResolvedValue({ outcome: 'timeout', hash: '0x123', errorMessage: 'Still pending' })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /claim refund/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Still pending'))
    expect(m.removePendingTx).not.toHaveBeenCalled()
  })

  it('links back to the crowdfund', () => {
    renderPage()
    expect(screen.getByRole('button', { name: /back to the crowdfund/i })).toBeTruthy()
  })
})
