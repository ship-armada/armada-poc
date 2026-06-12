// ABOUTME: Tests for ClaimFlowV2 — guards against showing a previous account's claim state after a wallet switch.
// ABOUTME: Mocks the ethers Contract reads so claimed/allocation can be driven per address.
// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { JsonRpcProvider } from 'ethers'
import { ClaimFlowV2, type ClaimFlowV2Props } from './ClaimFlowV2'

// Per-test read implementations, driven by the connected address.
let claimedFor: (addr: string) => Promise<boolean>
let allocationFor: (addr: string) => Promise<[bigint, bigint]>

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: vi.fn(function () {
      return {
        claimed: (addr: string) => claimedFor(addr),
        computeAllocation: (addr: string) => allocationFor(addr),
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

    const { rerender } = render(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_A} />)
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

    render(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_A} />)

    const input = (await screen.findByDisplayValue(ADDR_A)) as HTMLInputElement

    // User clears the field — it must not snap back to the wallet address.
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
  })
})
