// ABOUTME: Tests for ParticipateFlowV2's approve+commit pipeline lifecycle guards.
// ABOUTME: An unmounted (orphaned) pipeline must not fire a wallet prompt for the next tx.
// @vitest-environment jsdom

import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { ParticipateFlowV2, type ParticipateFlowV2Props } from './ParticipateFlowV2'
import { clearAllPipelines, pipelinesAtom } from '@/hooks/useTxPipeline'
import type { HopPosition } from '@/hooks/useEligibility'

// The wallet step renders RainbowKit's ConnectButton.Custom — stub the wallet
// libs so the flow (which starts connected and auto-advances past that step)
// renders without a Wagmi/RainbowKit provider tree.
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: () => null },
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
}))
vi.mock('wagmi', () => ({
  useDisconnect: () => ({ disconnect: vi.fn() }),
}))

// Drive the approve/commit contract calls via the mocked ethers Contract.
const approveSpy = vi.fn()
const commitSpy = vi.fn()
let approveImpl: () => Promise<unknown>
let commitImpl: () => Promise<unknown>

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: vi.fn(function () {
      return {
        approve: (...args: unknown[]) => {
          approveSpy(...args)
          return approveImpl()
        },
        commit: (...args: unknown[]) => {
          commitSpy(...args)
          return commitImpl()
        },
      }
    }),
  }
})

const ADDR = '0x' + 'a'.repeat(40)
const USDC = '0x' + 'd'.repeat(40)
const CROWDFUND = '0x' + 'c'.repeat(40)
const USDC_UNIT = 1_000_000n

const position: HopPosition = {
  hop: 0,
  invitesReceived: 1,
  committed: 0n,
  effectiveCap: 4000n * USDC_UNIT,
  remaining: 4000n * USDC_UNIT,
  invitesUsed: 0,
  invitesAvailable: 0,
  invitedBy: [],
}

let refreshAllowance: ReturnType<typeof vi.fn>
let onRunningChange: ReturnType<typeof vi.fn>

function makeProps(): ParticipateFlowV2Props {
  refreshAllowance = vi.fn().mockResolvedValue(undefined)
  onRunningChange = vi.fn()
  return {
    walletConnected: true,
    walletAddress: ADDR,
    signer: {} as never,
    positions: [position],
    balance: 10_000n * USDC_UNIT,
    needsApproval: () => true, // force the approve tx so the pipeline is 2 txs
    refreshAllowance: refreshAllowance as unknown as () => Promise<void>,
    crowdfundAddress: CROWDFUND,
    usdcAddress: USDC,
    hopStats: [
      { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
      { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
      { totalCommitted: 0n, cappedCommitted: 0n, whitelistCount: 0, uniqueCommitters: 0 },
    ],
    saleSize: 1_000_000n * USDC_UNIT,
    cappedDemand: 0n,
    windowOpen: true,
    onGoToMyPosition: vi.fn(),
    onGoToNetwork: vi.fn(),
    onReceiptLogs: vi.fn(),
    onRunningChange: onRunningChange as unknown as (running: boolean) => void,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The pipeline store is module-global — clear engine records and the atom so
  // a pipeline from a prior test doesn't bleed into the next render.
  clearAllPipelines()
  getDefaultStore().set(pipelinesAtom, {})
})

describe('ParticipateFlowV2 pipeline detach/resume', () => {
  it('pauses (no commit prompt) when the flow detaches mid-pipeline, and resumes on remount', async () => {
    // approve's receipt is deferred so we can detach while it is "in flight".
    let resolveApproveWait: ((r: unknown) => void) | undefined
    const approveTx = {
      hash: '0xapprove',
      wait: () =>
        new Promise((res) => {
          resolveApproveWait = res
        }),
    }
    approveImpl = () => Promise.resolve(approveTx)
    commitImpl = () =>
      Promise.resolve({ hash: '0xcommit', wait: () => Promise.resolve({ status: 1, logs: [] }) })

    const { unmount } = render(<ParticipateFlowV2 {...makeProps()} />)
    const firstRefresh = refreshAllowance

    // Wallet → commit auto-advance; enter an amount and go to review.
    const input = (await screen.findByRole('textbox')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    // Review → start the pipeline (approve, then commit).
    fireEvent.click(screen.getByRole('button', { name: 'Approve and commit' }))

    await act(async () => {})
    expect(approveSpy).toHaveBeenCalledTimes(1)
    expect(commitSpy).not.toHaveBeenCalled()

    // Detach the flow (modal closed) while approve's receipt is pending, then
    // let it resolve. The engine must pause before the commit send — no wallet
    // prompt with no UI behind it.
    unmount()
    await act(async () => {
      resolveApproveWait?.({ status: 1, logs: [] })
    })
    expect(firstRefresh).toHaveBeenCalled() // approve's `after` ran
    expect(commitSpy).not.toHaveBeenCalled()

    // Reopen the flow (remount, same address) → re-attach resumes the pipeline,
    // which now prompts for the commit it had parked on.
    render(<ParticipateFlowV2 {...makeProps()} />)
    await act(async () => {})
    expect(commitSpy).toHaveBeenCalledTimes(1)
  })

  it('clears the parent running flag when unmounted mid-pipeline', async () => {
    // Park the pipeline on the approve receipt so `submitting` stays true.
    approveImpl = () =>
      Promise.resolve({ hash: '0xapprove', wait: () => new Promise(() => {}) })
    commitImpl = () =>
      Promise.resolve({ hash: '0xcommit', wait: () => Promise.resolve({ status: 1, logs: [] }) })

    const { unmount } = render(<ParticipateFlowV2 {...makeProps()} />)

    const input = (await screen.findByRole('textbox')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve and commit' }))
    await act(async () => {})

    // The pipeline is in flight — the parent was told it is running.
    expect(onRunningChange).toHaveBeenCalledWith(true)

    // Closing the modal unmounts the flow; the parent's flag must reset so a
    // reopen doesn't think a pipeline is still running.
    unmount()
    expect(onRunningChange).toHaveBeenLastCalledWith(false)
  })
})

describe('ParticipateFlowV2 baseline capture', () => {
  it('captures committed baselines after events hydrate, not frozen at mount', async () => {
    // Open the flow while events are still hydrating (no positions yet).
    const { rerender } = render(
      <ParticipateFlowV2 {...makeProps()} eventsLoading positions={[]} />,
    )
    expect(screen.getByText('Checking eligibility…')).toBeTruthy()

    // Events hydrate with a fully-committed position. If the baseline froze at
    // mount (committed = 0), Step2 would show the input; with a correct capture
    // it reflects the hydrated committed amount → "fully committed".
    const fullPosition: HopPosition = {
      hop: 0,
      invitesReceived: 1,
      committed: 4000n * USDC_UNIT,
      effectiveCap: 4000n * USDC_UNIT,
      remaining: 0n,
      invitesUsed: 0,
      invitesAvailable: 0,
      invitedBy: [],
    }
    rerender(<ParticipateFlowV2 {...makeProps()} eventsLoading={false} positions={[fullPosition]} />)

    expect(await screen.findByText(/fully committed/i)).toBeTruthy()
  })
})
