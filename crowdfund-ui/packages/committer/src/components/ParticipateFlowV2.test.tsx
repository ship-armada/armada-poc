// ABOUTME: Tests for ParticipateFlowV2's approve+commit pipeline lifecycle guards.
// ABOUTME: An unmounted (orphaned) pipeline must not fire a wallet prompt for the next tx.
// @vitest-environment jsdom

import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ParticipateFlowV2, type ParticipateFlowV2Props } from './ParticipateFlowV2'
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

function makeProps(): ParticipateFlowV2Props {
  refreshAllowance = vi.fn().mockResolvedValue(undefined)
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
    onRunningChange: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ParticipateFlowV2 pipeline cancellation', () => {
  it('does not send the commit tx after the flow unmounts mid-pipeline', async () => {
    // approve's receipt is deferred so we can unmount while it is "in flight".
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

    // Wallet → commit auto-advance; enter an amount and go to review.
    const input = (await screen.findByRole('textbox')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    // Review → start the pipeline (approve, then commit).
    fireEvent.click(screen.getByRole('button', { name: 'Approve and commit' }))

    // Let the approve send fire and park on its receipt wait.
    await act(async () => {})
    expect(approveSpy).toHaveBeenCalledTimes(1)
    expect(commitSpy).not.toHaveBeenCalled()

    // Orphan the pipeline (e.g. modal close / account switch unmounts the flow),
    // then let approve's receipt resolve.
    unmount()
    await act(async () => {
      resolveApproveWait?.({ status: 1, logs: [] })
    })

    // The approve completed (refreshAllowance ran), but the cancelled pipeline
    // must never prompt for the commit tx.
    expect(refreshAllowance).toHaveBeenCalled()
    expect(commitSpy).not.toHaveBeenCalled()
  })
})
