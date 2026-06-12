// ABOUTME: Tests for ClaimFlowV2 — guards against showing a previous account's claim state after a wallet switch.
// ABOUTME: Mocks the ethers Contract reads so claimed/allocation can be driven per address.
// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JsonRpcProvider } from 'ethers'
import { ClaimFlowV2, type ClaimFlowV2Props } from './ClaimFlowV2'

// ClaimFlowV2 reads via react-query — each render gets a fresh client so query
// caches don't leak across tests.
function renderClaim(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  return render(ui, { wrapper })
}

// Per-test read implementations, driven by the connected address.
let claimedFor: (addr: string) => Promise<boolean>
let allocationFor: (addr: string) => Promise<[bigint, bigint]>
let claimImpl: () => Promise<unknown>

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: vi.fn(function () {
      return {
        claimed: (addr: string) => claimedFor(addr),
        computeAllocation: (addr: string) => allocationFor(addr),
        claim: () => claimImpl(),
        claimRefund: () => claimImpl(),
      }
    }),
  }
})

const ADDR_A = '0x' + 'a'.repeat(40)
const ADDR_B = '0x' + 'b'.repeat(40)

const baseProps: ClaimFlowV2Props = {
  walletConnected: true,
  walletAddress: ADDR_A,
  signer: null,
  provider: {} as unknown as JsonRpcProvider,
  crowdfundAddress: '0x' + 'c'.repeat(40),
  phase: 1,
  refundMode: false,
  blockTimestamp: 1_000,
  claimDeadline: 0,
  totalCommitted: 0n,
  windowEnd: 0,
  cappedDemand: 0n,
  claimAvailable: true,
  onGoToMyPosition: () => {},
  onGoToNetwork: () => {},
}

beforeEach(() => {
  vi.clearAllMocks()
  claimedFor = () => Promise.resolve(false)
  allocationFor = () => Promise.resolve([0n, 0n])
  claimImpl = () => Promise.resolve({ hash: '0xclaim', wait: () => Promise.resolve({ status: 1, logs: [] }) })
})

describe('ClaimFlowV2 account switch', () => {
  it('does not show the previous account\'s claimed done-screen while the new account loads', async () => {
    // Account A has already claimed → it lands on the "ARM claimed." done screen.
    // Account B's reads stay in flight (never resolve) so we can observe the
    // in-between render without a post-assertion state update.
    claimedFor = (addr) =>
      addr === ADDR_A ? Promise.resolve(true) : new Promise<boolean>(() => {})
    allocationFor = (addr) =>
      addr === ADDR_A ? Promise.resolve([0n, 0n]) : new Promise<[bigint, bigint]>(() => {})

    const { rerender } = renderClaim(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_A} />)
    // A resolves to claimed → done screen.
    expect(await screen.findByText('ARM claimed.')).toBeTruthy()

    // Switch to account B. Its reads are still pending.
    rerender(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_B} />)

    // The fetch effect must reset to loading so A's done-screen can't leak into
    // B's session while B's reads are outstanding.
    expect(await screen.findByText('Loading allocation…')).toBeTruthy()
    expect(screen.queryByText('ARM claimed.')).toBeNull()
  })
})

describe('ClaimFlowV2 delegate field', () => {
  it('stays empty after the user clears it (no auto-refill once edited)', async () => {
    // A non-zero ARM allocation, not yet claimed → the review step with the
    // delegate input renders, pre-filled with the connected wallet address.
    claimedFor = () => Promise.resolve(false)
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n])

    renderClaim(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_A} />)

    const input = (await screen.findByDisplayValue(ADDR_A)) as HTMLInputElement

    // User clears the field — it must not snap back to the wallet address.
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
  })
})

describe('ClaimFlowV2 wallet rejection', () => {
  it('returns to the review step (no error row) when the user declines in the wallet', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    claimImpl = () => Promise.reject({ code: 'ACTION_REJECTED' })

    renderClaim(<ClaimFlowV2 {...baseProps} signer={{} as never} walletAddress={ADDR_A} />)

    // Submit from the review step.
    const claimBtn = await screen.findByRole('button', { name: 'Claim ARM' })
    fireEvent.click(claimBtn)

    // Rejection routes back to review: the delegate input reappears and no
    // red error message is shown.
    expect(await screen.findByDisplayValue(ADDR_A)).toBeTruthy()
    expect(screen.queryByText('Transaction reverted')).toBeNull()
    expect(screen.queryByText(/Cancelled in wallet/)).toBeNull()
  })
})

describe('ClaimFlowV2 read semantics', () => {
  it('shows a retry (not a false 0 ARM) when the allocation read fails', async () => {
    claimedFor = () => Promise.resolve(false)
    allocationFor = () => Promise.reject(new Error('rpc down'))

    renderClaim(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_A} />)

    expect(await screen.findByText("Couldn't load your allocation")).toBeTruthy()
  })

  it('tolerates a failed claimed read (allocation still drives the review step)', async () => {
    claimedFor = () => Promise.reject(new Error('rpc'))
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n])

    renderClaim(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_A} />)

    // Allocation succeeded → review step (delegate input); the claimed failure
    // is non-fatal and must not surface the allocation-error screen.
    expect(await screen.findByDisplayValue(ADDR_A)).toBeTruthy()
    expect(screen.queryByText("Couldn't load your allocation")).toBeNull()
  })

  it('skips computeAllocation when the sale is cancelled (phase 2)', async () => {
    const alloc = vi.fn(() => Promise.resolve([0n, 0n] as [bigint, bigint]))
    allocationFor = alloc
    claimedFor = () => Promise.resolve(false)

    renderClaim(<ClaimFlowV2 {...baseProps} phase={2} walletAddress={ADDR_A} />)

    // Phase 2 → refund mode; with no committed USDC, the nothing-to-claim screen.
    expect(await screen.findByText('No refund to claim.')).toBeTruthy()
    expect(alloc).not.toHaveBeenCalled()
  })
})
