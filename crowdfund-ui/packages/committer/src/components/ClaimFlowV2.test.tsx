// ABOUTME: Tests for ClaimFlowV2 — guards against showing a previous account's claim state after a wallet switch.
// ABOUTME: Mocks the ethers Contract reads so claimed/allocation can be driven per address.
// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import type { JsonRpcProvider } from 'ethers'
import { ClaimFlowV2, type ClaimFlowV2Props } from './ClaimFlowV2'
import { clearClaimInFlight, setClaimInFlight } from '@/lib/claimInFlight'
import { clearPendingTxs } from '@/lib/pendingTx'

// ClaimFlowV2 reads via react-query — each render gets a fresh client so query
// caches don't leak across tests.
function renderClaim(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  return { ...render(ui, { wrapper }), client }
}

/** Walk intro → self-delegate → review for the ARM path. */
async function startArmToReview() {
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
  expect(await screen.findByRole('button', { name: 'Claim ARM' })).toBeTruthy()
}

/** Walk intro → Delegate vote → picker. */
async function startArmToDelegatePicker() {
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
  fireEvent.click(await screen.findByRole('radio', { name: /Delegate vote/i }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  return (await screen.findByLabelText('Search delegates')) as HTMLInputElement
}

// Per-test read implementations, driven by the connected address.
let claimedFor: (addr: string) => Promise<boolean>
let allocationFor: (addr: string) => Promise<[bigint, bigint]>
// Raw per-hop commitment (phase-2 refund path reads getCommitment per hop).
let commitmentFor: (addr: string, hop: number) => Promise<bigint>
let claimImpl: () => Promise<unknown>
// Captures the delegate argument passed to the on-chain `claim(delegate)` call.
let lastClaimDelegate: string | undefined

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: vi.fn(function () {
      return {
        claimed: (addr: string) => claimedFor(addr),
        computeAllocation: (addr: string) => allocationFor(addr),
        getCommitment: (addr: string, hop: number) => commitmentFor(addr, hop),
        claim: (delegate: string) => {
          lastClaimDelegate = delegate
          return claimImpl()
        },
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
  projectedRefund: false,
  claimAvailable: true,
  onGoToMyPosition: () => {},
  onGoToNetwork: () => {},
}

beforeEach(() => {
  vi.clearAllMocks()
  // Isolate sessionStorage between tests so an in-flight claim marker (or pending
  // tx) from one test doesn't make the next reconstruct an in-progress state.
  clearClaimInFlight()
  clearPendingTxs()
  claimedFor = () => Promise.resolve(false)
  allocationFor = () => Promise.resolve([0n, 0n])
  commitmentFor = () => Promise.resolve(0n)
  claimImpl = () => Promise.resolve({ hash: '0xclaim', wait: () => Promise.resolve({ status: 1, logs: [] }) })
  lastClaimDelegate = undefined
})

describe('ClaimFlowV2 pre-finalize gate', () => {
  // Window closed, finalize() not yet called: the contract still reports phase 0.
  const closedProps = { ...baseProps, phase: 0, windowEnd: 500, blockTimestamp: 1_000 }

  it('shows the refund heads-up when a refund is projected', async () => {
    renderClaim(<ClaimFlowV2 {...closedProps} projectedRefund={true} totalCommitted={15_000n * 10n ** 6n} />)
    expect(await screen.findByText('Sale ended below minimum')).toBeTruthy()
    expect(screen.getByText(/claim a refund of your committed \$15,000/)).toBeTruthy()
  })

  it('awaits finalization when no refund is projected', async () => {
    renderClaim(<ClaimFlowV2 {...closedProps} projectedRefund={false} />)
    expect(await screen.findByText('Awaiting finalization')).toBeTruthy()
    expect(screen.queryByText('Sale ended below minimum')).toBeNull()
  })
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

describe('ClaimFlowV2 refund intro + done table', () => {
  it('refund intro claims directly (no Review step) with the min-fund lead', async () => {
    commitmentFor = (_addr, hop) => Promise.resolve(hop === 0 ? 500_000_000n : 0n)

    renderClaim(<ClaimFlowV2 {...baseProps} phase={2} totalCommitted={0n} walletAddress={ADDR_A} />)

    expect(await screen.findByText('Claim your USDC refund')).toBeTruthy()
    expect(screen.getByText(/security council/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    expect(screen.getByRole('button', { name: /Claim .*refund/ })).toBeTruthy()
  })

  it('done screen folds destination + useful links into one summary', async () => {
    claimedFor = () => Promise.resolve(true)
    commitmentFor = (_addr, hop) => Promise.resolve(hop === 0 ? 500_000_000n : 0n)

    renderClaim(<ClaimFlowV2 {...baseProps} phase={2} totalCommitted={0n} walletAddress={ADDR_A} />)

    expect(await screen.findByText('USDC refund claimed')).toBeTruthy()
    expect(screen.getByText('Destination address')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Useful links' })).toBeTruthy()
  })
})

describe('ClaimFlowV2 delegate field', () => {
  it('stays empty after the user clears it (no auto-refill once edited)', async () => {
    claimedFor = () => Promise.resolve(false)
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n])

    renderClaim(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_A} />)

    const input = await startArmToDelegatePicker()

    // Prefill may be empty on "other"; type then clear — must not snap back to wallet.
    fireEvent.change(input, { target: { value: ADDR_A } })
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
  })

  it('rejects the zero address with a specific error and blocks the claim', async () => {
    claimedFor = () => Promise.resolve(false)
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM

    renderClaim(<ClaimFlowV2 {...baseProps} signer={{} as never} walletAddress={ADDR_A} />)

    const input = await startArmToDelegatePicker()
    fireEvent.change(input, { target: { value: '0x' + '0'.repeat(40) } })

    expect(await screen.findByText(/zero address/)).toBeTruthy()
    // Review CTA is blocked on the picker; Claim ARM is not yet reachable.
    const reviewBtn = screen.getByRole('button', { name: 'Review' })
    expect(reviewBtn.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('ClaimFlowV2 delegate ENS resolution', () => {
  // Vitalik's address — valid EIP-55 checksum, used as the resolver's answer.
  const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

  it('resolves an ENS name and submits the resolved address as the delegate', async () => {
    claimedFor = () => Promise.resolve(false)
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    const resolveName = vi.fn(async (name: string) => (name === 'vitalik.eth' ? VITALIK : null))
    const provider = { resolveName } as unknown as JsonRpcProvider

    renderClaim(
      <ClaimFlowV2 {...baseProps} signer={{} as never} provider={provider} walletAddress={ADDR_A} />,
    )

    const input = await startArmToDelegatePicker()
    fireEvent.change(input, { target: { value: 'vitalik.eth' } })

    // The name resolves, the resolved address surfaces, and the claim submits
    // the checksummed resolved address — not the raw ENS string.
    expect(await screen.findByText(/Resolves to|Ready to delegate|vitalik\.eth/i)).toBeTruthy()
    expect(resolveName).toHaveBeenCalledWith('vitalik.eth')

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Claim ARM' }))
    await waitFor(() => expect(lastClaimDelegate).toBe(VITALIK))
  })

  it('shows an error and blocks the claim for an unresolvable ENS name', async () => {
    claimedFor = () => Promise.resolve(false)
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n])
    const provider = { resolveName: vi.fn(async () => null) } as unknown as JsonRpcProvider

    renderClaim(
      <ClaimFlowV2 {...baseProps} signer={{} as never} provider={provider} walletAddress={ADDR_A} />,
    )

    const input = await startArmToDelegatePicker()
    fireEvent.change(input, { target: { value: 'nope.eth' } })

    expect(await screen.findByText(/resolve that ENS name/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review' }).getAttribute('aria-disabled')).toBe(
      'true',
    )
    expect(lastClaimDelegate).toBeUndefined()
  })
})

describe('ClaimFlowV2 wallet rejection', () => {
  it('returns to the review step (no error row) when the user declines in the wallet', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    claimImpl = () => Promise.reject({ code: 'ACTION_REJECTED' })

    renderClaim(<ClaimFlowV2 {...baseProps} signer={{} as never} walletAddress={ADDR_A} />)

    await startArmToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Claim ARM' }))

    // Rejection routes back to review: Claim ARM reappears and no red error.
    expect(await screen.findByRole('button', { name: 'Claim ARM' })).toBeTruthy()
    expect(screen.queryByText('Transaction reverted')).toBeNull()
    expect(screen.queryByText(/Cancelled in wallet/)).toBeNull()
  })
})

describe('ClaimFlowV2 submit step Back', () => {
  it('hides Back while the claim tx is pending', async () => {
    // Back mid-flight would hide a later revert/timeout and clear the in-flight
    // marker that lets a remount show "Submitting…" instead of a fresh Claim.
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    claimImpl = () => Promise.resolve({ hash: '0xclaim', wait: () => new Promise(() => {}) })
    // The read-provider race must stay pending too, or the claim errors out.
    const provider = { waitForTransaction: () => new Promise(() => {}) } as unknown as JsonRpcProvider

    renderClaim(
      <ClaimFlowV2 {...baseProps} signer={{} as never} provider={provider} walletAddress={ADDR_A} />,
    )

    await startArmToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Claim ARM' }))

    expect(await screen.findByText('Submitting…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  })
})

describe('ClaimFlowV2 stale data', () => {
  it('warns that claim data may be out of date when the connection drops', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    const { client } = renderClaim(<ClaimFlowV2 {...baseProps} />)
    expect(await screen.findByRole('button', { name: 'Start' })).toBeTruthy()
    expect(screen.queryByText('Connection interrupted')).toBeNull()

    try {
      await act(async () => {
        onlineManager.setOnline(false)
        void client.refetchQueries()
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(await screen.findByText('Connection interrupted')).toBeTruthy()
    } finally {
      // Back online: the paused refetch resumes and the warning clears.
      act(() => onlineManager.setOnline(true))
      await waitFor(() => expect(screen.queryByText('Connection interrupted')).toBeNull())
    }
  })
})

describe('ClaimFlowV2 in the Claim modal', () => {
  it('asks the modal for its X only on gate screens, which draw none of their own', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    const onModalCloseChange = vi.fn()
    const { rerender } = renderClaim(
      <ClaimFlowV2 {...baseProps} walletConnected={false} onModalCloseChange={onModalCloseChange} />,
    )
    expect(await screen.findByText('Connect your wallet to claim')).toBeTruthy()
    expect(onModalCloseChange).toHaveBeenLastCalledWith(true)

    rerender(<ClaimFlowV2 {...baseProps} onModalCloseChange={onModalCloseChange} />)
    expect(await screen.findByRole('button', { name: 'Start' })).toBeTruthy()
    expect(onModalCloseChange).toHaveBeenLastCalledWith(false)
  })

  it('closes in place via onClose (no page change) from the in-card X', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    const onClose = vi.fn()
    const onGoToNetwork = vi.fn()
    renderClaim(<ClaimFlowV2 {...baseProps} onClose={onClose} onGoToNetwork={onGoToNetwork} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Close claim flow' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(onGoToNetwork).not.toHaveBeenCalled()
  })
})

describe('ClaimFlowV2 close mid-claim', () => {
  it('reports the claim as running and asks before the in-card X closes', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    claimImpl = () => Promise.resolve({ hash: '0xclaim', wait: () => new Promise(() => {}) })
    const provider = { waitForTransaction: () => new Promise(() => {}) } as unknown as JsonRpcProvider
    const onGoToNetwork = vi.fn()
    const onRunningChange = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderClaim(
      <ClaimFlowV2
        {...baseProps}
        signer={{} as never}
        provider={provider}
        walletAddress={ADDR_A}
        onGoToNetwork={onGoToNetwork}
        onRunningChange={onRunningChange}
      />,
    )
    await startArmToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Claim ARM' }))
    expect(await screen.findByText('Submitting…')).toBeTruthy()
    expect(onRunningChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: 'Close claim flow' }))
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(onGoToNetwork).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})

describe('ClaimFlowV2 review tooltip', () => {
  it('opens the ARM allocation tooltip below its icon so the card top cannot clip it', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    renderClaim(<ClaimFlowV2 {...baseProps} />)
    await startArmToReview()

    fireEvent.focus(screen.getByRole('button', { name: 'ARM allocation details' }))

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain('The ARM tokens delivered to your wallet')
    expect(tooltip.className).toMatch(/below/)
  })
})

describe('ClaimFlowV2 Final commit', () => {
  const USDC = 1_000_000n
  const finalCommit = async () =>
    (await screen.findByText('Final commit')).nextElementSibling?.textContent

  it('shows the on-chain commitment even while the indexer total lags at zero', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM
    commitmentFor = (_addr, hop) => Promise.resolve(hop === 0 ? 5_000n * USDC : 0n)

    renderClaim(<ClaimFlowV2 {...baseProps} totalCommitted={0n} walletAddress={ADDR_A} />)

    await waitFor(async () => expect(await finalCommit()).toBe('$5,000'))
  })

  it('matches the refund for an over-cap commit (not the capped indexer total)', async () => {
    // Refund-mode finalized sale: the whole raw deposit comes back.
    allocationFor = () => Promise.resolve([0n, 5_000n * USDC])
    commitmentFor = (_addr, hop) => Promise.resolve(hop === 0 ? 5_000n * USDC : 0n)

    renderClaim(
      <ClaimFlowV2 {...baseProps} refundMode totalCommitted={4_000n * USDC} walletAddress={ADDR_A} />,
    )

    await waitFor(async () => expect(await finalCommit()).toBe('$5,000'))
  })
})

describe('ClaimFlowV2 read semantics', () => {
  it('shows a retry (not a false 0 ARM) when the allocation read fails', async () => {
    claimedFor = () => Promise.resolve(false)
    allocationFor = () => Promise.reject(new Error('rpc down'))

    renderClaim(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_A} />)

    expect(await screen.findByText("Couldn't load your allocation")).toBeTruthy()
  })

  it('tolerates a failed claimed read (allocation still drives the intro step)', async () => {
    claimedFor = () => Promise.reject(new Error('rpc'))
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n])

    renderClaim(<ClaimFlowV2 {...baseProps} walletAddress={ADDR_A} />)

    // Allocation succeeded → intro; the claimed failure is non-fatal and must
    // not surface the allocation-error screen.
    expect(await screen.findByText('Claim your ARM tokens')).toBeTruthy()
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

describe('ClaimFlowV2 in-flight watcher', () => {
  it('surfaces a "still pending" row (not a stuck spinner) when the receipt wait times out', async () => {
    // Reconstruct an in-flight claim from a persisted marker, then have the read
    // provider's waitForTransaction reject with an ethers v6 TIMEOUT (its real
    // timeout semantics — it rejects, it does not resolve null).
    setClaimInFlight({ hash: '0xpending', mode: 'arm', address: ADDR_A, sentAt: 1 })
    // Non-zero allocation so the flow lands on the reconstructed submit step
    // rather than the zero-allocation "nothing to claim" screen.
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n])
    const waitForTransaction = vi.fn().mockRejectedValue({ code: 'TIMEOUT', message: 'timeout' })
    const provider = { waitForTransaction } as unknown as JsonRpcProvider

    renderClaim(<ClaimFlowV2 {...baseProps} provider={provider} walletAddress={ADDR_A} />)

    // The timeout must land on an actionable "still pending" error, not leave the
    // user parked on "Submitting…" forever.
    expect(
      await screen.findByText(/Still pending — it may still confirm/),
    ).toBeTruthy()
    // Confirmations + timeout are threaded to the wait call.
    expect(waitForTransaction).toHaveBeenCalledWith('0xpending', expect.any(Number), expect.any(Number))
  })
})

describe('ClaimFlowV2 refund gate (contract-authoritative)', () => {
  it('shows the on-chain refund even when the indexer total lags on a cold load (phase 2)', async () => {
    // Cancelled sale: the event-graph total is still 0 (cold load / lagging
    // indexer), but the contract reports a real commitment via getCommitment.
    commitmentFor = (_addr, hop) => Promise.resolve(hop === 0 ? 500_000_000n : 0n) // 500 USDC at hop 0

    renderClaim(<ClaimFlowV2 {...baseProps} phase={2} totalCommitted={0n} walletAddress={ADDR_A} />)

    // Intro renders from the contract amount — never the false
    // "No refund to claim." terminal screen the graph total would have produced.
    expect(await screen.findByText('Claim your USDC refund')).toBeTruthy()
    expect(screen.queryByText('No refund to claim.')).toBeNull()
  })

  it('still shows "No refund to claim" when the address genuinely committed nothing (phase 2)', async () => {
    commitmentFor = () => Promise.resolve(0n)

    renderClaim(<ClaimFlowV2 {...baseProps} phase={2} totalCommitted={0n} walletAddress={ADDR_A} />)

    expect(await screen.findByText('No refund to claim.')).toBeTruthy()
  })
})

describe('ClaimFlowV2 ARM claim deadline', () => {
  const PAST = { claimDeadline: 1_000, blockTimestamp: 2_000 }

  it('gates the ARM claim past the deadline instead of showing phantom ARM', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n]) // 1 ARM, no refund

    renderClaim(<ClaimFlowV2 {...baseProps} {...PAST} walletAddress={ADDR_A} />)

    expect(await screen.findByText('ARM claim window closed')).toBeTruthy()
    expect(screen.getByText(/nothing left to claim/i)).toBeTruthy()
    // No phantom "in your wallet" ARM copy, and no claim action (nothing to claim).
    expect(screen.queryByText(/in your wallet/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Claim/ })).toBeNull()
  })

  it('offers the USDC refund claim past the deadline when there is an over-cap refund', async () => {
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 250_000_000n]) // ARM forfeited, 250 USDC refund

    renderClaim(<ClaimFlowV2 {...baseProps} {...PAST} signer={{} as never} walletAddress={ADDR_A} />)

    expect(await screen.findByText('ARM claim window closed')).toBeTruthy()
    // The refund is claimable; ARM is not offered.
    const refundBtn = screen.getByRole('button', { name: /Claim .*refund/ })
    expect(refundBtn).toBeTruthy()
    expect(screen.queryByText(/in your wallet/)).toBeNull()

    // Claiming past the deadline succeeds without a delegate (contract skips it).
    fireEvent.click(refundBtn)
    await waitFor(() => expect(lastClaimDelegate).toBeDefined())
  })

  it('done screen past the deadline never asserts ARM landed', async () => {
    claimedFor = () => Promise.resolve(true) // already claimed, revisited after the deadline
    allocationFor = () => Promise.resolve([1_000_000_000_000_000_000n, 0n])

    renderClaim(<ClaimFlowV2 {...baseProps} {...PAST} walletAddress={ADDR_A} />)

    expect(await screen.findByText('Claim complete.')).toBeTruthy()
    expect(screen.queryByText(/in your wallet/)).toBeNull()
    expect(screen.queryByText('ARM claimed.')).toBeNull()
  })
})

describe('ClaimFlowV2 wrong-network gate', () => {
  it('prompts a network switch (not "connect wallet") when connected on the wrong chain', () => {
    const switchNetwork = vi.fn()
    renderClaim(
      <ClaimFlowV2
        {...baseProps}
        walletConnected={false}
        isWrongNetwork
        switchNetwork={switchNetwork}
      />,
    )
    expect(screen.getByText('Wrong network')).toBeTruthy()
    expect(screen.queryByText('Connect your wallet to claim')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /switch to/i }))
    expect(switchNetwork).toHaveBeenCalled()
  })

  it('shows the connect-wallet copy when simply disconnected', () => {
    renderClaim(<ClaimFlowV2 {...baseProps} walletConnected={false} isWrongNetwork={false} />)
    expect(screen.getByText('Connect your wallet to claim')).toBeTruthy()
    expect(screen.queryByText('Wrong network')).toBeNull()
  })
})
